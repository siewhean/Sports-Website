#!/usr/bin/env node

/**
 * Writes a sanitized, exact-SHA local Gate B evidence manifest.
 *
 * The caller supplies only the retained evidence-bundle path. This writer
 * opens and hashes that bundle itself and derives the immutable artifact URI.
 *
 * Usage:
 *   node scripts/write-browser-gate-evidence.mjs --input /safe/ledger.json
 *     [--output artifacts/qa/gate-b/<sha>/browser-gate-evidence.json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHA40_PATTERN = /^[a-f0-9]{40}$/u;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const WCAG_TAGS = Object.freeze(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
export const REQUIRED_PROJECTS = Object.freeze(["phone-chromium", "tablet-webkit", "desktop-chromium"]);
export const REQUIRED_COMMANDS = Object.freeze([
  ["node-version", "node --version"],
  ["pnpm-version", "pnpm --version"],
  ["frozen-install", "pnpm install --frozen-lockfile"],
  ["lockfile-unchanged", "git diff --exit-code -- pnpm-lock.yaml"],
  ["clean-outputs", "pnpm ci:assert-clean-outputs"],
  ["format", "pnpm format:check"],
  ["lint", "pnpm lint"],
  ["typecheck", "pnpm typecheck"],
  ["unit", "pnpm test:unit"],
  ["migrations", "pnpm db:migrate:check"],
  ["backup-restore", "pnpm backup:verify"],
  ["integration", "RUN_INFRA_TESTS=1 pnpm test:integration"],
  ["fixtures", "pnpm validate:fixtures"],
  ["phase-2", "pnpm validate:phase2"],
  ["phase-3", "pnpm validate:phase3"],
  ["phase-4", "pnpm validate:phase4"],
  ["openapi", "pnpm openapi:check"],
  ["dependency-audit", "pnpm dependencies:audit"],
  ["secret-scan", "pnpm secrets:scan"],
  ["build", "pnpm build"],
  ["deployment-manifest", "pnpm deploy:manifest"],
  ["asset-delivery", "pnpm asset-delivery:verify:origin"],
  ["playwright-install", "pnpm --filter @matchday/web exec playwright install --with-deps chromium webkit"],
  ["e2e", "pnpm test:e2e"],
  ["accessibility", "pnpm test:a11y"],
  ["visual", "pnpm test:visual"],
  ["diff-check", "git diff --check"],
  ["umbrella-check", "pnpm check"],
  [
    "focus-state-repeat",
    "pnpm --filter @matchday/web exec playwright test tests/phase-4-gateb-state-preservation.spec.ts --project=desktop-chromium --repeat-each=5",
  ],
  ["real-journeys", "pnpm test:e2e:phase4:real"],
]);

const SENSITIVE_KEY_PATTERN =
  /(?:access.?token|api.?key|authorization|connection.?string|cookie|credential|csrf|password|private.?key|refresh.?token|secret|session(?:.?id|.?token)?)/iu;
const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/iu,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function fail(message) {
  throw new Error(`Gate B evidence refused: ${message}`);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--input" || option === "--output") {
      result[option.slice(2)] = argv[++index];
    } else {
      fail(`unknown option ${option}`);
    }
  }
  if (!result.input) fail("--input is required");
  return result;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

export function findSecretLikeData(value, location = "manifest") {
  const findings = [];

  function visit(entry, currentLocation) {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${currentLocation}[${index}]`));
      return;
    }
    if (isPlainObject(entry)) {
      for (const [key, child] of Object.entries(entry)) {
        const childLocation = `${currentLocation}.${key}`;
        if (SENSITIVE_KEY_PATTERN.test(key)) findings.push(`${childLocation} is a forbidden sensitive field`);
        visit(child, childLocation);
      }
      return;
    }
    if (typeof entry === "string" && SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(entry))) {
      findings.push(`${currentLocation} contains a secret-like value`);
    }
  }

  visit(value, location);
  return findings;
}

function assertNoSecretLikeData(value, location) {
  const [finding] = findSecretLikeData(value, location);
  if (finding) fail(finding);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function skipReasons(value, skipped, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (skipped === 0) {
    if (value.length !== 0) fail(`${label} must be empty when counts.skipped is zero`);
    return [];
  }
  if (value.length === 0) fail(`${label} must explain every intentional skip`);

  const reasons = value.map((entry, index) => {
    assertPlainObject(entry, `${label}[${index}]`);
    const reason = requiredString(entry.reason, `${label}[${index}].reason`);
    const count = requiredInteger(entry.count, `${label}[${index}].count`);
    if (count === 0) fail(`${label}[${index}].count must be positive`);
    return { reason, count };
  });
  const explained = reasons.reduce((total, entry) => total + entry.count, 0);
  if (explained !== skipped) fail(`${label} counts must sum exactly to counts.skipped`);
  return reasons;
}

function relativeLocation(root, candidate, label) {
  if (typeof candidate !== "string" || candidate.trim() === "") fail(`${label} must be a path`);
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    fail(`${label} must stay inside the repository`);
  return { absolute, relative: relative.split(path.sep).join("/") };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function readRegularFileWithin({ root, candidate, label, allowedDirectory = "." }) {
  const location = relativeLocation(root, candidate, label);
  const details = await lstat(location.absolute).catch(() => null);
  if (!details) fail(`${label} is unavailable`);
  if (details.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  if (!details.isFile()) fail(`${label} must identify a regular file`);

  const rootReal = await realpath(root);
  const allowedLexical = path.resolve(root, allowedDirectory);
  const allowedReal = await realpath(allowedLexical).catch(() => null);
  if (!allowedReal || (allowedReal !== rootReal && !isWithin(rootReal, allowedReal)))
    fail(`${label} allowed directory escapes the repository`);
  const expectedAllowedReal = path.resolve(rootReal, allowedDirectory);
  if (allowedReal !== expectedAllowedReal) fail(`${label} allowed directory must not contain symbolic links`);

  const fileReal = await realpath(location.absolute);
  if (!isWithin(allowedReal, fileReal)) fail(`${label} resolves outside its allowed directory`);
  if (fileReal !== path.resolve(rootReal, location.relative)) fail(`${label} path must not contain symbolic links`);

  const content = await readFile(fileReal);
  return {
    content,
    retention_location: location.relative,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

async function checksum(root, candidate, label) {
  const { content: _content, ...metadata } = await readRegularFileWithin({ root, candidate, label });
  return metadata;
}

async function canonicalCommands(root, source) {
  if (!Array.isArray(source)) fail("commands must be an array");
  const canonical = new Map(REQUIRED_COMMANDS);
  if (source.length !== canonical.size)
    fail(`commands must contain exactly the ${canonical.size} canonical Gate B commands`);

  const seen = new Set();
  const result = [];
  for (const [index, command] of source.entries()) {
    assertPlainObject(command, `commands[${index}]`);
    const id = requiredString(command.id, `commands[${index}].id`);
    if (seen.has(id)) fail(`commands contains duplicate id ${id}`);
    seen.add(id);
    const exactCommand = canonical.get(id);
    if (!exactCommand) fail(`commands[${index}].id is not a canonical Gate B command`);
    if (command.command !== exactCommand) fail(`command ${id} does not match the canonical command`);

    const exitCode = requiredInteger(command.exit_code, `commands[${index}].exit_code`);
    const counts = assertPlainObject(command.counts, `commands[${index}].counts`);
    const passed = requiredInteger(counts.passed, `commands[${index}].counts.passed`);
    const failed = requiredInteger(counts.failed, `commands[${index}].counts.failed`);
    const skipped = requiredInteger(counts.skipped, `commands[${index}].counts.skipped`);
    const reasons = skipReasons(command.skip_reasons, skipped, `commands[${index}].skip_reasons`);
    if (command.unexpected_skipped !== 0) fail(`commands[${index}].unexpected_skipped must be zero`);
    if (exitCode !== 0 || failed !== 0) fail(`command ${id} must exit 0 with failed=0`);

    result.push({
      id,
      command: exactCommand,
      exit_code: 0,
      counts: { passed, failed: 0, skipped },
      skip_reasons: reasons,
      unexpected_skipped: 0,
      log: await checksum(root, command.log_path, `commands[${index}].log_path`),
    });
  }

  for (const [id] of REQUIRED_COMMANDS) if (!seen.has(id)) fail(`commands is missing required command ${id}`);
  return result;
}

async function artifacts(root, entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) fail(`${label} must be a non-empty array`);
  return Promise.all(entries.map((entry, index) => checksum(root, entry, `${label}[${index}]`)));
}

function isolationRuns(value) {
  if (!Array.isArray(value) || value.length !== 2) fail("isolation_runs must contain exactly two runs");
  const seenDatabase = new Set();
  const seenRedisIdentifier = new Set();
  const seenRedisHash = new Set();

  return value.map((run, index) => {
    assertPlainObject(run, `isolation_runs[${index}]`);
    if (run.run_number !== index + 1) fail(`isolation_runs[${index}].run_number must be ${index + 1}`);
    if (run.command_id !== "real-journeys") fail(`isolation_runs[${index}].command_id must be real-journeys`);

    const database = requiredString(run.database_identifier, `isolation_runs[${index}].database_identifier`);
    const redisIdentifier = requiredString(
      run.redis_namespace_identifier,
      `isolation_runs[${index}].redis_namespace_identifier`,
    );
    const redisHash = requiredString(run.redis_namespace_sha256, `isolation_runs[${index}].redis_namespace_sha256`);
    if (!database.startsWith("redacted:")) fail(`isolation_runs[${index}].database_identifier must be redacted`);
    if (!redisIdentifier.startsWith("redacted:"))
      fail(`isolation_runs[${index}].redis_namespace_identifier must be redacted`);
    if (!SHA256_PATTERN.test(redisHash))
      fail(`isolation_runs[${index}].redis_namespace_sha256 must be a SHA-256 digest`);
    if (seenDatabase.has(database) || seenRedisIdentifier.has(redisIdentifier) || seenRedisHash.has(redisHash))
      fail("isolation runs must use distinct database and Redis namespace isolation");
    seenDatabase.add(database);
    seenRedisIdentifier.add(redisIdentifier);
    seenRedisHash.add(redisHash);

    if (run.status !== "PASS") fail(`isolation_runs[${index}] did not pass`);
    if (requiredInteger(run.initial_owned_key_count, `isolation_runs[${index}].initial_owned_key_count`) !== 0)
      fail(`isolation_runs[${index}] did not start with zero owned Redis keys`);
    if (requiredInteger(run.final_owned_key_count, `isolation_runs[${index}].final_owned_key_count`) !== 0)
      fail(`isolation_runs[${index}] did not finish with zero owned Redis keys`);
    if (run.unrelated_guard_preserved !== true) fail(`isolation_runs[${index}].unrelated_guard_preserved must be true`);

    const projects = Array.isArray(run.browser_projects) ? run.browser_projects : [];
    for (const project of REQUIRED_PROJECTS)
      if (!projects.includes(project)) fail(`isolation_runs[${index}] is missing ${project}`);

    return {
      run_number: run.run_number,
      command_id: run.command_id,
      status: "PASS",
      database_identifier: database,
      redis_namespace_identifier: redisIdentifier,
      redis_namespace_sha256: redisHash,
      initial_owned_key_count: 0,
      final_owned_key_count: 0,
      unrelated_guard_preserved: true,
      browser_projects: [...projects],
    };
  });
}

async function immutablePublication(root, sha, publication) {
  assertPlainObject(publication, "immutable_publication");
  const keys = Object.keys(publication);
  if (keys.length !== 1 || keys[0] !== "bundle_path")
    fail("immutable_publication accepts bundle_path only; caller URI or digest fields are forbidden");

  const allowedDirectory = path.join("artifacts", "qa", "gate-b", sha);
  const bundle = await readRegularFileWithin({
    root,
    candidate: publication.bundle_path,
    label: "immutable_publication.bundle_path",
    allowedDirectory,
  });
  return {
    retention_location: bundle.retention_location,
    evidence_bundle_sha256: bundle.sha256,
    bytes: bundle.bytes,
    uri: `artifact://gate-b/${sha}/${bundle.sha256}`,
  };
}

export async function buildBrowserGateEvidence({ root, input }) {
  assertPlainObject(input, "input");
  assertNoSecretLikeData(input, "input");
  const sha = git(root, ["rev-parse", "HEAD"]);
  if (!SHA40_PATTERN.test(sha)) fail("HEAD is not a full commit SHA");
  if (git(root, ["status", "--porcelain=v1"]) !== "") fail("working tree must be clean before evidence generation");

  const environment = assertPlainObject(input.environment, "environment");
  const accessibility = assertPlainObject(input.accessibility, "accessibility");
  const browserRuntime = assertPlainObject(input.browser_runtime, "browser_runtime");
  const findings = assertPlainObject(input.findings, "findings");
  if (process.version !== "v24.18.0") fail(`Node must be v24.18.0, received ${process.version}`);
  if (environment.pnpm_version !== "10.33.0") fail(`pnpm must be 10.33.0, received ${environment.pnpm_version}`);
  if (accessibility.status !== "PASS" || accessibility.target_size_executed !== true)
    fail("WCAG target-size must execute and pass");
  if (JSON.stringify(accessibility.wcag_tags) !== JSON.stringify(WCAG_TAGS))
    fail("WCAG tags must be exactly the Gate B A/AA set");
  if (!Array.isArray(accessibility.enabled_rules) || !accessibility.enabled_rules.includes("target-size"))
    fail("target-size must be explicitly enabled");
  if (browserRuntime.console_errors !== 0 || browserRuntime.page_errors !== 0 || browserRuntime.failed_requests !== 0)
    fail("browser runtime errors must be zero");
  if (findings.p0 !== 0 || findings.p1 !== 0) fail("P0 and P1 must be zero");
  if (input.final_verdict !== "PASS")
    fail("final_verdict must be PASS; use no artifact until the gate is actually complete");

  const review = await checksum(root, input.review_document_path, "review_document_path");
  const manifest = {
    schema_version: 2,
    artifact_kind: "gate-b-browser-evidence",
    generated_at_utc: new Date().toISOString(),
    source: { commit_sha: sha, branch: git(root, ["branch", "--show-current"]), clean_before_generation: true },
    environment: {
      operating_system: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      node_version: process.version,
      pnpm_version: requiredString(environment.pnpm_version, "environment.pnpm_version"),
      postgresql_version: requiredString(environment.postgresql_version, "environment.postgresql_version"),
      redis_version: requiredString(environment.redis_version, "environment.redis_version"),
      playwright_version: requiredString(environment.playwright_version, "environment.playwright_version"),
      chromium_version: requiredString(environment.chromium_version, "environment.chromium_version"),
      webkit_version: requiredString(environment.webkit_version, "environment.webkit_version"),
    },
    commands: await canonicalCommands(root, input.commands),
    isolation_runs: isolationRuns(input.isolation_runs),
    accessibility: {
      status: "PASS",
      wcag_tags: [...WCAG_TAGS],
      enabled_rules: ["target-size"],
      target_size_executed: true,
      reports: await artifacts(root, accessibility.report_paths, "accessibility.report_paths"),
    },
    visual: {
      status: input.visual?.status === "PASS" ? "PASS" : fail("visual.status must be PASS"),
      artifacts: await artifacts(root, input.visual?.artifact_paths, "visual.artifact_paths"),
    },
    production_build:
      input.production_build?.status === "PASS" && input.production_build.exit_code === 0
        ? { status: "PASS", exit_code: 0 }
        : fail("production_build must pass with exit code 0"),
    browser_runtime: { console_errors: 0, page_errors: 0, failed_requests: 0 },
    review: {
      retention_location: review.retention_location,
      sha256: review.sha256,
      bytes: review.bytes,
    },
    findings: { p0: 0, p1: 0 },
    immutable_publication: await immutablePublication(root, sha, input.immutable_publication),
    final_verdict: "PASS",
  };
  assertNoSecretLikeData(manifest, "manifest");
  return manifest;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(root, args.input);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const evidence = await buildBrowserGateEvidence({ root, input });
  const output = args.output
    ? path.resolve(root, args.output)
    : path.join(root, "artifacts", "qa", "gate-b", evidence.source.commit_sha, "browser-gate-evidence.json");
  if (!output.startsWith(`${root}${path.sep}`)) fail("--output must stay inside the repository");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(path.relative(root, output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
