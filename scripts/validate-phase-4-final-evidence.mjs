#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  ["real-journey-1", "pnpm test:e2e:phase4:real"],
  ["real-journey-2", "pnpm test:e2e:phase4:real"],
]);

export const EVIDENCE_ONLY_PATHS = Object.freeze([
  "docs/qa/phase-4-final-evidence.json",
  "docs/qa/phase-4-final-evidence.md",
  "docs/qa/phase-4-local-run.md",
  "docs/qa/phase-4-verdict.md",
]);

const REQUIRED_BROWSER_PROJECTS = new Set(["phone-chromium", "tablet-webkit", "desktop-chromium"]);
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SENSITIVE_KEY_PATTERN =
  /(?:^|_)(?:access_?token|api_?key|authorization|cookie|credential|password|private_?key|refresh_?token|secret|session|session_?id|session_?token)(?:$|_)/iu;
const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/iu,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHash(value, path, errors) {
  if (typeof value !== "string" || !SHA_256_PATTERN.test(value)) {
    errors.push(`${path} must be a lowercase 64-character SHA-256 digest`);
  }
}

function findSecretLikeFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSecretLikeFields(entry, `${path}[${index}]`, errors));
    return;
  }

  if (!isRecord(value)) {
    if (typeof value === "string" && SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`${path} contains a secret-like value`);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      errors.push(`${entryPath} is a secret-like field`);
    }
    findSecretLikeFields(entry, entryPath, errors);
  }
}

function validateEnvironment(environment, errors) {
  if (!isRecord(environment)) {
    errors.push("environment must be an object");
    return;
  }

  for (const field of [
    "operating_system",
    "architecture",
    "node_version",
    "pnpm_version",
    "postgresql_version",
    "redis_version",
    "playwright_version",
    "chromium_version",
    "webkit_version",
  ]) {
    if (typeof environment[field] !== "string" || environment[field].trim() === "") {
      errors.push(`environment.${field} must be present`);
    }
  }
}

function validateCommands(commands, errors) {
  if (!Array.isArray(commands)) {
    errors.push("commands must be an array");
    return;
  }

  const commandsById = new Map();
  for (const command of commands) {
    if (!isRecord(command) || typeof command.id !== "string") {
      errors.push("every commands entry must have a string id");
      continue;
    }
    if (commandsById.has(command.id)) {
      errors.push(`commands contains duplicate id ${command.id}`);
      continue;
    }
    commandsById.set(command.id, command);
  }

  for (const [id, exactCommand] of REQUIRED_COMMANDS) {
    const command = commandsById.get(id);
    if (!command) {
      errors.push(`required command ${id} is missing`);
      continue;
    }
    if (command.exact_command !== exactCommand) {
      errors.push(`required command ${id} does not match the canonical command`);
    }
    if (command.status !== "PASS" || command.exit_status !== 0) {
      errors.push(`required command ${id} did not pass`);
      continue;
    }
    if (typeof command.duration_ms !== "number" || !Number.isFinite(command.duration_ms) || command.duration_ms < 0) {
      errors.push(`required command ${id} has no valid duration_ms`);
    }
    for (const count of ["passed", "failed", "skipped"]) {
      if (!Number.isInteger(command[count]) || command[count] < 0) {
        errors.push(`required command ${id} has no valid ${count} count`);
      }
    }
    if (command.failed !== 0) {
      errors.push(`required command ${id} records failed checks`);
    }
    if (command.skipped !== 0) {
      errors.push(`required command ${id} records skipped checks`);
    }
    if (command.skip_reason !== null && command.skip_reason !== undefined && command.skip_reason !== "") {
      errors.push(`required command ${id} has an unexpected skip reason`);
    }
    validateHash(command.raw_log_sha256, `commands.${id}.raw_log_sha256`, errors);
    if (typeof command.raw_log_retention_location !== "string" || command.raw_log_retention_location.trim() === "") {
      errors.push(`commands.${id}.raw_log_retention_location must be present`);
    }
  }
}

function validateJourneys(journeys, errors) {
  if (!Array.isArray(journeys)) {
    errors.push("isolated_journeys must be an array");
    return;
  }

  for (const requiredId of ["isolation-1", "isolation-2"]) {
    const journey = journeys.find((entry) => entry?.id === requiredId);
    if (!journey) {
      errors.push(`isolated journey ${requiredId} is missing`);
      continue;
    }
    if (journey.status !== "PASS") {
      errors.push(`isolated journey ${requiredId} did not pass`);
      continue;
    }
    if (journey.command_id !== `real-journey-${requiredId.slice(-1)}`) {
      errors.push(`isolated journey ${requiredId} has the wrong command_id`);
    }
    for (const field of ["database_isolation_identifier", "redis_isolation_identifier"]) {
      if (typeof journey[field] !== "string" || !journey[field].startsWith("redacted:")) {
        errors.push(`isolated journey ${requiredId} ${field} must be a redacted identifier`);
      }
    }
    const projects = new Set(Array.isArray(journey.browser_projects) ? journey.browser_projects : []);
    for (const project of REQUIRED_BROWSER_PROJECTS) {
      if (!projects.has(project)) {
        errors.push(`isolated journey ${requiredId} is missing browser project ${project}`);
      }
    }
  }

  const first = journeys.find((entry) => entry?.id === "isolation-1");
  const second = journeys.find((entry) => entry?.id === "isolation-2");
  if (
    first &&
    second &&
    typeof first.database_isolation_identifier === "string" &&
    first.database_isolation_identifier === second.database_isolation_identifier
  ) {
    errors.push("isolated journeys reuse the same database identifier");
  }
  if (
    first &&
    second &&
    typeof first.redis_isolation_identifier === "string" &&
    first.redis_isolation_identifier === second.redis_isolation_identifier
  ) {
    errors.push("isolated journeys reuse the same Redis identifier");
  }
}

function validateArtifacts(artifacts, errors) {
  if (!isRecord(artifacts)) {
    errors.push("artifacts must be an object");
    return;
  }
  for (const category of ["playwright_html_reports", "screenshots", "traces"]) {
    const entries = artifacts[category];
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`artifacts.${category} must contain at least one artifact`);
      continue;
    }
    entries.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push(`artifacts.${category}[${index}] must be an object`);
        return;
      }
      if (typeof entry.retention_location !== "string" || entry.retention_location.trim() === "") {
        errors.push(`artifacts.${category}[${index}].retention_location must be present`);
      }
      validateHash(entry.sha256, `artifacts.${category}[${index}].sha256`, errors);
    });
  }
}

function validateSourceProvenance(
  { sourceCommitExists, sourceCommitIsAncestor, changedPathsSinceSource, workingTreeChangedPaths },
  errors,
) {
  if (sourceCommitExists !== true) {
    errors.push("source.commit_sha does not identify a commit in this repository");
  } else if (sourceCommitIsAncestor !== true) {
    errors.push("source.commit_sha is not an ancestor of the checked-out commit");
  }

  const allowedPaths = new Set(EVIDENCE_ONLY_PATHS);
  for (const [label, paths] of [
    ["path changed after the validated source commit", changedPathsSinceSource],
    ["working tree path differs from the checked-out commit", workingTreeChangedPaths],
  ]) {
    if (!Array.isArray(paths)) {
      errors.push(`${label} list is unavailable`);
      continue;
    }
    for (const path of paths) {
      if (!allowedPaths.has(path)) {
        errors.push(`${label} and is not evidence-only: ${path}`);
      }
    }
  }
}

export function validatePhase4FinalEvidence(
  manifest,
  { sourceCommitExists, sourceCommitIsAncestor, changedPathsSinceSource, workingTreeChangedPaths } = {},
) {
  const errors = [];
  if (!isRecord(manifest)) {
    return ["manifest root must be an object"];
  }

  if (manifest.schema_version !== 1) {
    errors.push("schema_version must be 1");
  }
  if (manifest.local_validation !== "PASS") {
    errors.push("local_validation must be PASS");
  }
  if (manifest.hosted_github_actions !== "Not executed because Actions allowance is unavailable") {
    errors.push("hosted_github_actions must use the approved truthful label");
  }
  if (!isRecord(manifest.source)) {
    errors.push("source must be an object");
  } else {
    if (!COMMIT_SHA_PATTERN.test(manifest.source.commit_sha ?? "")) {
      errors.push("source.commit_sha must be a full lowercase commit SHA");
    }
    if (typeof manifest.source.branch !== "string" || manifest.source.branch.trim() === "") {
      errors.push("source.branch must be present");
    }
  }
  validateSourceProvenance(
    {
      sourceCommitExists,
      sourceCommitIsAncestor,
      changedPathsSinceSource,
      workingTreeChangedPaths,
    },
    errors,
  );

  if (typeof manifest.evidence_collected_at !== "string" || Number.isNaN(Date.parse(manifest.evidence_collected_at))) {
    errors.push("evidence_collected_at must be an ISO-8601 timestamp");
  }
  if (
    !isRecord(manifest.reviewer) ||
    typeof manifest.reviewer.identity !== "string" ||
    manifest.reviewer.identity.trim() === ""
  ) {
    errors.push("reviewer.identity must be a privacy-safe non-empty label");
  }

  validateEnvironment(manifest.environment, errors);
  validateCommands(manifest.commands, errors);
  validateJourneys(manifest.isolated_journeys, errors);
  validateArtifacts(manifest.artifacts, errors);

  for (const summary of ["accessibility", "visual", "browser_runtime"]) {
    const value = manifest.summaries?.[summary];
    if (!isRecord(value) || value.status !== "PASS") {
      errors.push(`summaries.${summary}.status must be PASS`);
    }
  }

  const browserRuntime = manifest.summaries?.browser_runtime;
  if (isRecord(browserRuntime)) {
    for (const field of ["console_errors", "page_errors", "failed_requests"]) {
      if (browserRuntime[field] !== 0) {
        errors.push(`summaries.browser_runtime.${field} must be 0`);
      }
    }
  }

  findSecretLikeFields(manifest, "", errors);
  return errors;
}

function gitOutput(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function gitCommandSucceeds(repositoryRoot, args) {
  try {
    execFileSync("git", args, {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function outputPaths(output) {
  return output === "" ? [] : output.split("\n").filter(Boolean);
}

function inspectSourceProvenance(repositoryRoot, sourceCommit) {
  const currentCommit = gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
  const sourceCommitExists =
    COMMIT_SHA_PATTERN.test(sourceCommit ?? "") &&
    gitCommandSucceeds(repositoryRoot, ["cat-file", "-e", `${sourceCommit}^{commit}`]);
  const sourceCommitIsAncestor =
    sourceCommitExists &&
    gitCommandSucceeds(repositoryRoot, ["merge-base", "--is-ancestor", sourceCommit, currentCommit]);
  const changedPathsSinceSource = sourceCommitExists
    ? outputPaths(
        gitOutput(repositoryRoot, [
          "diff",
          "--name-only",
          "--diff-filter=ACDMRTUXB",
          `${sourceCommit}..${currentCommit}`,
          "--",
        ]),
      )
    : [];
  const workingTreeChangedPaths = new Set([
    ...outputPaths(gitOutput(repositoryRoot, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "HEAD", "--"])),
    ...outputPaths(
      gitOutput(repositoryRoot, ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "HEAD", "--"]),
    ),
    ...outputPaths(gitOutput(repositoryRoot, ["ls-files", "--others", "--exclude-standard"])),
  ]);

  return {
    sourceCommitExists,
    sourceCommitIsAncestor,
    changedPathsSinceSource,
    workingTreeChangedPaths: [...workingTreeChangedPaths].sort(),
  };
}

export function validatePhase4FinalEvidenceFile({ manifestPath, repositoryRoot }) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`cannot read evidence manifest: ${error.message}`];
  }

  let provenance;
  try {
    provenance = inspectSourceProvenance(repositoryRoot, manifest.source?.commit_sha);
  } catch (error) {
    return [`cannot inspect evidence source provenance: ${error.message}`];
  }
  return validatePhase4FinalEvidence(manifest, provenance);
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === scriptPath;

if (isDirectExecution) {
  const manifestPath = resolve(repositoryRoot, process.argv[2] ?? "docs/qa/phase-4-final-evidence.json");
  const errors = validatePhase4FinalEvidenceFile({
    manifestPath,
    repositoryRoot,
  });

  if (errors.length > 0) {
    console.error(
      `Phase 4 final evidence validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):`,
    );
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Phase 4 final evidence validation passed.");
  }
}
