#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSecretLikeData,
  isPlainObject,
  REQUIRED_COMMANDS,
  REQUIRED_PROJECTS,
  SHA256_PATTERN,
  SHA40_PATTERN,
  WCAG_TAGS,
} from "./write-browser-gate-evidence.mjs";

const ENVIRONMENT_FIELDS = [
  "operating_system",
  "architecture",
  "node_version",
  "pnpm_version",
  "postgresql_version",
  "redis_version",
  "playwright_version",
  "chromium_version",
  "webkit_version",
];

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function reopenArtifact(root, item, label, errors, { allowedDirectory = "." } = {}) {
  if (
    !isPlainObject(item) ||
    typeof item.retention_location !== "string" ||
    !SHA256_PATTERN.test(item.sha256 ?? "") ||
    !Number.isInteger(item.bytes) ||
    item.bytes < 0
  ) {
    errors.push(`${label} has invalid retention metadata`);
    return null;
  }

  const lexical = path.resolve(root, item.retention_location);
  const relative = path.relative(root, lexical);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label} escapes the repository`);
    return null;
  }

  try {
    const details = await lstat(lexical);
    if (details.isSymbolicLink()) {
      errors.push(`${label} must not be a symbolic link`);
      return null;
    }
    if (!details.isFile()) {
      errors.push(`${label} is not a regular file`);
      return null;
    }

    const rootReal = await realpath(root);
    const allowedReal = await realpath(path.resolve(root, allowedDirectory));
    if (allowedReal !== rootReal && !isWithin(rootReal, allowedReal)) {
      errors.push(`${label} allowed directory escapes the repository`);
      return null;
    }
    if (allowedReal !== path.resolve(rootReal, allowedDirectory)) {
      errors.push(`${label} allowed directory must not contain symbolic links`);
      return null;
    }
    const fileReal = await realpath(lexical);
    if (!isWithin(allowedReal, fileReal)) {
      errors.push(`${label} resolves outside its allowed directory`);
      return null;
    }
    if (fileReal !== path.resolve(rootReal, item.retention_location)) {
      errors.push(`${label} path must not contain symbolic links`);
      return null;
    }

    const content = await readFile(fileReal);
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== item.bytes) errors.push(`${label} byte size does not match`);
    if (digest !== item.sha256) errors.push(`${label} checksum does not match`);
    return { digest, bytes: content.byteLength };
  } catch {
    errors.push(`${label} is unavailable`);
    return null;
  }
}

function validateCommands(commands, errors) {
  if (!Array.isArray(commands)) {
    errors.push("commands must be an array");
    return;
  }
  const canonical = new Map(REQUIRED_COMMANDS);
  if (commands.length !== canonical.size)
    errors.push(`commands must contain exactly the ${canonical.size} canonical Gate B commands`);

  const seen = new Set();
  for (const command of commands) {
    const id = command?.id;
    if (typeof id !== "string") {
      errors.push("every command must have a string id");
      continue;
    }
    if (seen.has(id)) errors.push("commands contains duplicate IDs");
    seen.add(id);
    if (!canonical.has(id)) {
      errors.push(`command ${id} is not a canonical Gate B command`);
      continue;
    }
    if (command.command !== canonical.get(id)) errors.push(`command ${id} does not match the canonical command`);
    if (!Number.isInteger(command.duration_ms) || command.duration_ms <= 0)
      errors.push(`command ${id} duration_ms must be a positive integer`);
    for (const count of ["passed", "failed", "skipped"]) {
      if (!Number.isInteger(command?.counts?.[count]) || command.counts[count] < 0)
        errors.push(`command ${id} has invalid ${count} count`);
    }
    const skipped = command?.counts?.skipped;
    if (!Array.isArray(command.skip_reasons)) {
      errors.push(`command ${id} skip_reasons must be an array`);
    } else if (skipped === 0 && command.skip_reasons.length !== 0) {
      errors.push(`command ${id} skip_reasons must be empty when skipped is zero`);
    } else if (Number.isInteger(skipped) && skipped > 0) {
      if (command.skip_reasons.length === 0) {
        errors.push(`command ${id} skip_reasons must explain every intentional skip`);
      } else {
        let explained = 0;
        for (const [index, entry] of command.skip_reasons.entries()) {
          if (
            !isPlainObject(entry) ||
            typeof entry.reason !== "string" ||
            entry.reason.trim() === "" ||
            !Number.isInteger(entry.count) ||
            entry.count <= 0
          ) {
            errors.push(`command ${id} skip_reasons[${index}] is invalid`);
          } else {
            explained += entry.count;
          }
        }
        if (explained !== skipped) errors.push(`command ${id} skip reason counts do not equal counts.skipped`);
      }
    }
    if (command.exit_code !== 0 || command?.counts?.failed !== 0 || command.unexpected_skipped !== 0)
      errors.push(`command ${id} must exit 0 with failed=0 and unexpected_skipped=0`);
  }
  for (const [id] of REQUIRED_COMMANDS) if (!seen.has(id)) errors.push(`required command ${id} is missing`);
}

function validateIsolationRuns(runs, errors) {
  if (!Array.isArray(runs) || runs.length !== 2) {
    errors.push("exactly two isolation runs are required");
    return;
  }

  const databases = new Set();
  const redisIdentifiers = new Set();
  const redisHashes = new Set();
  for (const [index, run] of runs.entries()) {
    const number = index + 1;
    if (run?.run_number !== number) errors.push(`isolation run ${number} has the wrong run number`);
    if (run?.command_id !== "real-journeys") errors.push(`isolation run ${number} has the wrong journey command`);
    if (run?.status !== "PASS") errors.push(`isolation run ${number} did not pass`);
    if (typeof run?.database_identifier !== "string" || !run.database_identifier.startsWith("redacted:"))
      errors.push(`isolation run ${number} database identifier is not redacted`);
    if (typeof run?.redis_namespace_identifier !== "string" || !run.redis_namespace_identifier.startsWith("redacted:"))
      errors.push(`isolation run ${number} Redis namespace identifier is not redacted`);
    if (!SHA256_PATTERN.test(run?.redis_namespace_sha256 ?? ""))
      errors.push(`isolation run ${number} Redis namespace hash is invalid`);
    if (run?.initial_owned_key_count !== 0 || run?.final_owned_key_count !== 0)
      errors.push(`isolation run ${number} does not prove zero owned Redis keys at its boundaries`);
    if (run?.unrelated_guard_preserved !== true)
      errors.push(`isolation run ${number} did not preserve the unrelated-key guard`);

    databases.add(run?.database_identifier);
    redisIdentifiers.add(run?.redis_namespace_identifier);
    redisHashes.add(run?.redis_namespace_sha256);
    for (const project of REQUIRED_PROJECTS)
      if (!run?.browser_projects?.includes(project)) errors.push(`isolation run ${number} lacks ${project}`);
  }
  if (databases.size !== 2 || redisIdentifiers.size !== 2 || redisHashes.size !== 2)
    errors.push("isolation runs are not independent");
}

export async function validateBrowserGateEvidence({ root, manifest }) {
  const errors = [];
  if (!isPlainObject(manifest)) return ["manifest must be an object"];
  errors.push(...findSecretLikeData(manifest, "manifest"));

  if (manifest.schema_version !== 2 || manifest.artifact_kind !== "gate-b-browser-evidence")
    errors.push("manifest is not a Gate B schema v2 artifact");
  if (!SHA40_PATTERN.test(manifest.source?.commit_sha ?? "")) errors.push("source.commit_sha must be a full SHA");
  const head = git(root, ["rev-parse", "HEAD"]);
  if (manifest.source?.commit_sha !== head) errors.push("artifact SHA is not the checked-out SHA");
  if (git(root, ["status", "--porcelain=v1"]) !== "") errors.push("working tree is not clean");
  if (manifest.source?.clean_before_generation !== true)
    errors.push("artifact does not prove a clean source tree before generation");

  for (const field of ENVIRONMENT_FIELDS) {
    if (typeof manifest.environment?.[field] !== "string" || manifest.environment[field].trim() === "")
      errors.push(`environment.${field} is missing`);
  }
  if (manifest.environment?.node_version !== "v24.18.0") errors.push("Node v24.18.0 is required");
  if (manifest.environment?.pnpm_version !== "10.33.0") errors.push("pnpm 10.33.0 is required");
  if (manifest.final_verdict !== "PASS" || manifest.findings?.p0 !== 0 || manifest.findings?.p1 !== 0)
    errors.push("verdict requires P0=0 and P1=0");
  if (
    JSON.stringify(manifest.accessibility?.wcag_tags) !== JSON.stringify(WCAG_TAGS) ||
    manifest.accessibility?.target_size_executed !== true ||
    !manifest.accessibility?.enabled_rules?.includes("target-size")
  )
    errors.push("WCAG A/AA tags and target-size execution are incomplete");
  if (manifest.accessibility?.status !== "PASS") errors.push("accessibility did not pass");
  if (manifest.visual?.status !== "PASS") errors.push("visual validation did not pass");
  if (manifest.production_build?.status !== "PASS" || manifest.production_build?.exit_code !== 0)
    errors.push("production build did not pass");
  if (["console_errors", "page_errors", "failed_requests"].some((key) => manifest.browser_runtime?.[key] !== 0))
    errors.push("browser runtime counts must be zero");

  validateCommands(manifest.commands, errors);
  validateIsolationRuns(manifest.isolation_runs, errors);

  for (const [label, entries] of [
    ["commands", manifest.commands],
    ["accessibility reports", manifest.accessibility?.reports],
    ["visual artifacts", manifest.visual?.artifacts],
  ]) {
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`${label} are missing`);
    } else {
      for (const [index, entry] of entries.entries())
        await reopenArtifact(root, entry.log ?? entry, `${label}[${index}]`, errors);
    }
  }
  await reopenArtifact(root, manifest.review, "review document", errors);

  const publication = manifest.immutable_publication;
  const publicationKeys = isPlainObject(publication) ? Object.keys(publication).sort() : [];
  const expectedPublicationKeys = ["bytes", "evidence_bundle_sha256", "retention_location", "uri"];
  if (
    !isPlainObject(publication) ||
    JSON.stringify(publicationKeys) !== JSON.stringify(expectedPublicationKeys) ||
    typeof publication.retention_location !== "string" ||
    !SHA256_PATTERN.test(publication.evidence_bundle_sha256 ?? "") ||
    !Number.isInteger(publication.bytes) ||
    publication.bytes < 0
  ) {
    errors.push("immutable publication metadata is invalid");
  } else {
    const allowedDirectory = path.join("artifacts", "qa", "gate-b", head);
    const bundle = await reopenArtifact(
      root,
      {
        retention_location: publication.retention_location,
        sha256: publication.evidence_bundle_sha256,
        bytes: publication.bytes,
      },
      "immutable publication bundle",
      errors,
      { allowedDirectory },
    );
    const expectedUri = `artifact://gate-b/${head}/${publication.evidence_bundle_sha256}`;
    if (publication.uri !== expectedUri) errors.push("immutable publication URI is not canonical for HEAD and digest");
    if (bundle && publication.evidence_bundle_sha256 !== bundle.digest)
      errors.push("immutable publication digest does not match the retained bundle");
  }
  return errors;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const artifact =
    process.argv[2] ?? `artifacts/qa/gate-b/${git(root, ["rev-parse", "HEAD"])}/browser-gate-evidence.json`;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.resolve(root, artifact), "utf8"));
  } catch (error) {
    console.error(`Gate B evidence validation failed: cannot read artifact (${error.message})`);
    process.exitCode = 1;
    return;
  }
  const errors = await validateBrowserGateEvidence({ root, manifest });
  if (errors.length) {
    console.error(`Gate B evidence validation failed (${errors.length}):`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log("Gate B exact-SHA evidence validation passed.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
