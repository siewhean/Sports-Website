#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredInfrastructureServices, requiredLocalCommands } from "./run-gate-c-access-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const gateCC3Projects = [
  "gate-c-c3-phone-chromium",
  "gate-c-c3-phone-webkit",
  "gate-c-c3-desktop-chromium",
  "gate-c-c3-desktop-webkit",
  "gate-c-c3-desktop-firefox",
];
export const gateCC3Scenarios = [
  "online_preparation",
  "offline_event_and_local_reversal",
  "page_refresh",
  "browser_restart",
  "strict_ordered_replay",
  "lost_response_idempotency",
  "pending_finalisation",
  "sequence_divergence",
  "stale_generation_takeover",
  "expiry_and_revocation",
  "four_hour_recording_boundary",
  "sign_out_with_unresolved_queue",
  "sanitised_export",
  "storage_corruption",
  "service_worker_update",
];
export const gateCC3PhysicalPlatforms = ["ios", "android"];
export const gateCC3PhysicalScenarios = [
  "online_preparation",
  "offline_event_and_local_reversal",
  "page_refresh",
  "browser_restart",
  "strict_ordered_replay",
  "pending_finalisation",
  "stale_generation_takeover",
  "sanitised_export",
];
export const gateCC3ScenarioAssertions = {
  online_preparation: ["authority_issued", "worker_ready"],
  offline_event_and_local_reversal: ["event_queued", "local_reversal_queued"],
  page_refresh: ["queue_recovered"],
  browser_restart: ["persistent_profile_relaunched", "queue_recovered"],
  strict_ordered_replay: ["contiguous_order", "one_at_a_time"],
  lost_response_idempotency: ["duplicate_receipt", "no_duplicate_mutation"],
  pending_finalisation: ["local_pending", "publication_acknowledged"],
  sequence_divergence: ["queue_retained", "replay_stopped"],
  stale_generation_takeover: ["queue_retained", "takeover_conflict"],
  expiry_and_revocation: ["expired_read_only", "revoked_read_only"],
  four_hour_recording_boundary: ["at_boundary_blocked", "before_allowed", "grace_transmission_only"],
  sign_out_with_unresolved_queue: ["export_before_discard", "signout_intercepted"],
  sanitised_export: ["deterministic_hash", "secret_scan_clean"],
  storage_corruption: ["cache_loss_recovered", "corruption_visible", "indexeddb_loss_safe"],
  service_worker_update: ["safe_activation", "update_deferred"],
};
export const gateCC3ScenarioObservationKeys = {
  online_preparation: ["service_worker_version", "queue_count"],
  offline_event_and_local_reversal: ["queued_command_count", "local_reversal_count"],
  page_refresh: ["recovered_command_count"],
  browser_restart: ["recovered_command_count", "persistent_profile_reused"],
  strict_ordered_replay: ["replayed_command_count", "maximum_concurrent_requests", "replay_client_id_sha256"],
  lost_response_idempotency: ["duplicate_receipt_sha256", "mutation_count"],
  pending_finalisation: ["local_status", "confirmed_result_version"],
  sequence_divergence: ["conflict_code", "retained_command_count"],
  stale_generation_takeover: ["conflict_code", "retained_command_count"],
  expiry_and_revocation: ["expired_state", "revoked_state"],
  four_hour_recording_boundary: ["before_boundary_allowed", "at_boundary_blocked", "grace_replay_only"],
  sign_out_with_unresolved_queue: ["signout_intercepted", "export_sha256"],
  sanitised_export: ["export_sha256", "sensitive_data_scan_clean"],
  storage_corruption: ["conflict_code", "retained_command_count"],
  service_worker_update: ["active_version", "waiting_version", "activation_deferred"],
};
export const gateCC3RequiredScreenshotPaths = [
  "screenshots/offline-ready.png",
  "screenshots/offline-two-pending.png",
  "screenshots/offline-browser-restart.png",
  "screenshots/offline-replay-complete.png",
];
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const requiredGateCC3Commands = [
  ...requiredLocalCommands,
  {
    label: "browser-install-c3",
    command: "pnpm",
    args: ["--filter", "@matchday/web", "exec", "playwright", "install", "chromium", "webkit", "firefox"],
  },
  { label: "c3-evidence-tools", command: "pnpm", args: ["test:evidence:gate-c-c3"] },
];

function assertHash(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function exactSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function canonicalEvidenceJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertNoGateCC3Secrets(value, segments = []) {
  if (typeof value === "string") {
    assertNoGateCC3SecretText(value, segments.join(".") || "<root>");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoGateCC3Secrets(item, [...segments, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const next = [...segments, key];
    if (/(?:^|_)(?:token|secret|password|cookie|authorization|access_url|raw_device_id|client_ip)(?:_|$)/iu.test(key)) {
      throw new Error(`Secret-like evidence field is forbidden: ${next.join(".")}`);
    }
    if (typeof item === "string") assertNoGateCC3SecretText(item, next.join("."));
    if (typeof item === "object" && item !== null) assertNoGateCC3Secrets(item, next);
  }
}

function assertNoGateCC3SecretText(value, label) {
  if (
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]+|(?:authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+|eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@|redis:\/\/[^/\s]+:[^@\s]+@|#access=|__Secure-matchday-offline-grant)/iu.test(
      value,
    )
  ) {
    throw new Error(`Secret-like evidence value is forbidden: ${label}`);
  }
}

export function validateGateCC3DiscoveryOutput(output) {
  let total = 0;
  for (const project of gateCC3Projects) {
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const count = [...output.matchAll(new RegExp(`\\[${escaped}\\]`, "gu"))].length;
    if (count < 1) throw new Error(`Gate C C3 ledger discovered no tests for ${project}`);
    total += count;
  }
  const reported = Number(output.match(/Total:\s+(\d+)\s+tests?/u)?.[1] ?? "0");
  if (reported !== total) throw new Error("Gate C C3 Playwright discovery total is inconsistent");
  return total;
}

export function validateGateCC3RunReceipt(receipt, sourceSha) {
  if (
    receipt?.artifact_kind !== "gate-c-c3-run-evidence" ||
    receipt?.source_sha !== sourceSha ||
    receipt?.failed_count !== 0 ||
    receipt?.skipped_count !== 0 ||
    !Array.isArray(receipt?.projects) ||
    receipt.projects.length !== gateCC3Projects.length
  ) {
    throw new Error("Gate C C3 run is not an all-pass exact-SHA receipt");
  }
  let passCount = 0;
  for (const [index, expectedProject] of gateCC3Projects.entries()) {
    const project = receipt.projects[index];
    if (
      project?.project_name !== expectedProject ||
      !Number.isSafeInteger(project?.pass_count) ||
      project.pass_count < 1 ||
      project.evidence_path !== `${expectedProject}/project-evidence.json` ||
      !Number.isFinite(project.duration_ms) ||
      project.duration_ms <= 0
    ) {
      throw new Error(`Gate C C3 run receipt is invalid for ${expectedProject}`);
    }
    passCount += project.pass_count;
  }
  if (receipt.pass_count !== passCount) throw new Error("Gate C C3 aggregate pass count is invalid");
  assertNoGateCC3Secrets(receipt);
  return receipt.projects;
}

export function validateGateCC3ProjectReceipt(receipt, sourceSha, expectedProject, expectedPassCount) {
  if (
    receipt?.artifact_kind !== "gate-c-c3-project-evidence" ||
    receipt?.source_sha !== sourceSha ||
    receipt?.project_name !== expectedProject ||
    receipt?.pass_count !== expectedPassCount ||
    receipt?.failed_count !== 0 ||
    receipt?.skipped_count !== 0
  ) {
    throw new Error(`${expectedProject} is not an all-pass exact-SHA project receipt`);
  }
  assertHash(receipt?.postgresql?.identifier_sha256, `${expectedProject} PostgreSQL identifier`);
  assertHash(receipt?.redis?.namespace_sha256, `${expectedProject} Redis namespace`);
  assertHash(receipt?.browser_profile_sha256, `${expectedProject} browser profile`);
  if (
    receipt?.redis?.initial_owned_key_count !== 0 ||
    receipt?.redis?.final_owned_key_count !== 0 ||
    receipt?.redis?.unrelated_guard_preserved !== true ||
    !receipt?.browser_version?.trim() ||
    receipt?.indexeddb_schema_version !== 1 ||
    !/^(?:matchday|gate-c)-[a-z0-9-]+-v\d+$/u.test(receipt?.service_worker_version ?? "")
  ) {
    throw new Error(`${expectedProject} isolation or browser proof is incomplete`);
  }
  if (!exactSet(receipt?.screenshot_paths, gateCC3RequiredScreenshotPaths)) {
    throw new Error(`${expectedProject} does not retain the canonical success screenshot set`);
  }
  if (
    !exactSet(
      receipt?.scenarios?.map((item) => item?.scenario),
      gateCC3Scenarios,
    )
  ) {
    throw new Error(`${expectedProject} does not prove every required offline scenario exactly once`);
  }
  const scenarioHashes = new Set();
  for (const item of receipt.scenarios) {
    if (item?.status !== "passed") throw new Error(`${expectedProject}/${item?.scenario} did not pass`);
    assertHash(item?.receipt_sha256, `${expectedProject}/${item?.scenario}`);
    scenarioHashes.add(item.receipt_sha256);
  }
  if (!Array.isArray(receipt?.artifact_hashes) || receipt.artifact_hashes.length < 1) {
    throw new Error(`${expectedProject} has no artifact hashes`);
  }
  for (const artifact of receipt.artifact_hashes) {
    if (
      !artifact?.path ||
      artifact.path.startsWith("/") ||
      artifact.path.split(/[\\/]/u).includes("..") ||
      !Number.isSafeInteger(artifact?.size_bytes) ||
      artifact.size_bytes < 1
    ) {
      throw new Error(`${expectedProject} has an invalid artifact receipt`);
    }
    assertHash(artifact.sha256, `${expectedProject}/${artifact.path}`);
  }
  const artifactHashes = new Set(receipt.artifact_hashes.map((artifact) => artifact.sha256));
  if (
    scenarioHashes.size !== gateCC3Scenarios.length ||
    [...scenarioHashes].some((receiptHash) => !artifactHashes.has(receiptHash))
  ) {
    throw new Error(`${expectedProject} scenario receipts are reused or not bound to retained artifacts`);
  }
  assertNoGateCC3Secrets(receipt);
  return receipt;
}

export function validateGateCC3PhysicalReceipts(receipts, sourceSha) {
  if (!Array.isArray(receipts) || receipts.length !== gateCC3PhysicalPlatforms.length) {
    throw new Error("Gate C C3 requires one physical iOS receipt and one physical Android receipt");
  }
  const platforms = [];
  for (const receipt of receipts) {
    if (
      receipt?.artifact_kind !== "gate-c-c3-physical-device-receipt" ||
      receipt?.schema_version !== 2 ||
      receipt?.source_sha !== sourceSha ||
      !gateCC3PhysicalPlatforms.includes(receipt?.platform) ||
      receipt?.status !== "passed" ||
      receipt?.failed_count !== 0 ||
      receipt?.skipped_count !== 0 ||
      !receipt?.device_model?.trim() ||
      !receipt?.os_version?.trim() ||
      !receipt?.browser_name?.trim() ||
      !receipt?.browser_version?.trim() ||
      !Number.isFinite(Date.parse(receipt?.collected_at ?? "")) ||
      !Number.isFinite(Date.parse(receipt?.captured_at ?? "")) ||
      !receipt?.trusted_https_origin_sha256 ||
      !receipt?.deployment ||
      !/^dpl_[A-Za-z0-9]+$/u.test(receipt.deployment.deployment_id ?? "") ||
      !receipt.deployment.build_id?.trim() ||
      !receipt.deployment.route_manifest_sha256 ||
      !Array.isArray(receipt?.artifact_hashes) ||
      receipt.artifact_hashes.length < 1
    ) {
      throw new Error("Gate C C3 physical-device receipt is incomplete or failed");
    }
    assertHash(receipt.trusted_https_origin_sha256, `${receipt.platform} HTTPS origin`);
    assertHash(receipt.profile_identifier_sha256, `${receipt.platform} profile identifier`);
    assertHash(receipt.receipt_sha256, `${receipt.platform} journey receipt`);
    assertHash(receipt.tester_attestation_sha256, `${receipt.platform} tester attestation`);
    assertHash(receipt.capture_id_sha256, `${receipt.platform} capture identifier`);
    assertHash(receipt.collector_sha256, `${receipt.platform} collector`);
    assertHash(receipt.device_run_id_sha256, `${receipt.platform} device run identifier`);
    assertHash(receipt.deployment.route_manifest_sha256, `${receipt.platform} approved route manifest`);
    const { receipt_sha256: claimedReceiptHash, ...unsignedReceipt } = receipt;
    if (createHash("sha256").update(canonicalEvidenceJson(unsignedReceipt)).digest("hex") !== claimedReceiptHash) {
      throw new Error(`${receipt.platform} physical receipt hash is not bound to its canonical contents`);
    }
    for (const artifact of receipt.artifact_hashes) {
      if (
        !artifact?.path ||
        artifact.path.startsWith("/") ||
        artifact.path.split(/[\\/]/u).includes("..") ||
        !Number.isSafeInteger(artifact?.size_bytes) ||
        artifact.size_bytes < 1
      ) {
        throw new Error(`${receipt.platform} has an invalid physical artifact receipt`);
      }
      assertHash(artifact.sha256, `${receipt.platform}/${artifact.path}`);
    }
    if (
      !exactSet(
        receipt.scenarios?.map((item) => item?.scenario),
        gateCC3PhysicalScenarios,
      )
    ) {
      throw new Error(`${receipt.platform} does not prove every required C3 scenario`);
    }
    const scenarioHashes = new Set();
    for (const scenario of receipt.scenarios) {
      if (scenario?.status !== "passed") throw new Error(`${receipt.platform}/${scenario?.scenario} did not pass`);
      assertHash(scenario?.receipt_sha256, `${receipt.platform}/${scenario?.scenario}`);
      scenarioHashes.add(scenario.receipt_sha256);
    }
    const artifactHashes = new Set(receipt.artifact_hashes.map((artifact) => artifact.sha256));
    if (
      scenarioHashes.size !== gateCC3PhysicalScenarios.length ||
      [...scenarioHashes].some((receiptHash) => !artifactHashes.has(receiptHash))
    ) {
      throw new Error(`${receipt.platform} scenario receipts are reused or not bound to retained artifacts`);
    }
    platforms.push(receipt.platform);
    assertNoGateCC3Secrets(receipt);
  }
  if (!exactSet(platforms, gateCC3PhysicalPlatforms)) {
    throw new Error("Gate C C3 physical-device platforms are duplicated or missing");
  }
  return receipts;
}

export function validateGateCC3Certification(manifest, expectedSourceSha) {
  if (
    manifest?.schema_version !== 1 ||
    manifest?.artifact_kind !== "gate-c-c3-exact-sha-ledger" ||
    manifest?.source_sha !== expectedSourceSha
  ) {
    throw new Error("Gate C C3 evidence is not bound to the expected source SHA");
  }
  if (
    manifest?.environment?.node_version !== "v24.18.0" ||
    manifest?.environment?.pnpm_version !== "10.33.0" ||
    !manifest?.environment?.postgresql_version?.trim() ||
    !manifest?.environment?.redis_version?.trim() ||
    !manifest?.environment?.mailpit_version?.trim() ||
    !manifest?.environment?.playwright_version?.trim() ||
    !manifest?.environment?.browser_versions?.chromium?.trim() ||
    !manifest?.environment?.browser_versions?.webkit?.trim() ||
    !manifest?.environment?.browser_versions?.firefox?.trim()
  ) {
    throw new Error("Gate C C3 exact-SHA environment receipt is incomplete or unpinned");
  }
  const requiredCommands = [
    ...requiredGateCC3Commands.map((item) => ({
      label: item.label,
      command: [item.command, ...item.args].join(" "),
    })),
    ...[1, 2].map((run) => ({
      label: `gate-c-c3-real-${run}`,
      command: "pnpm test:e2e:gate-c-c3:real",
    })),
  ];
  if (
    !Array.isArray(manifest.commands) ||
    manifest.commands.length !== requiredCommands.length ||
    manifest.commands.some(
      (command, index) =>
        command?.label !== requiredCommands[index].label || command?.command !== requiredCommands[index].command,
    )
  ) {
    throw new Error("Gate C C3 evidence is missing or changed a canonical required command");
  }
  for (const command of manifest.commands) {
    if (command?.exit_code !== 0 || command?.failed_count > 0 || command?.skipped_count > 0) {
      throw new Error(`Gate C C3 required command did not pass without skips: ${command?.label}`);
    }
    assertHash(command?.log_sha256, `${command?.label} log`);
  }
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 2) {
    throw new Error("Gate C C3 requires exactly two isolated browser-matrix runs");
  }
  if (
    !manifest.discovery_counts ||
    Object.keys(manifest.discovery_counts).length !== gateCC3Projects.length ||
    gateCC3Projects.some(
      (project) => !Number.isSafeInteger(manifest.discovery_counts[project]) || manifest.discovery_counts[project] < 1,
    )
  ) {
    throw new Error("Gate C C3 evidence has no exact Playwright discovery counts");
  }
  const postgres = new Set();
  const redis = new Set();
  const profiles = new Set();
  for (const [index, run] of manifest.runs.entries()) {
    if (
      run?.run_number !== index + 1 ||
      !Array.isArray(run?.projects) ||
      run.projects.length !== gateCC3Projects.length
    ) {
      throw new Error(`Gate C C3 run ${index + 1} is incomplete`);
    }
    for (const [projectIndex, project] of run.projects.entries()) {
      const expectedProject = gateCC3Projects[projectIndex];
      validateGateCC3ProjectReceipt(
        project,
        expectedSourceSha,
        expectedProject,
        manifest.discovery_counts[expectedProject],
      );
      const engine = expectedProject.endsWith("chromium")
        ? "chromium"
        : expectedProject.endsWith("webkit")
          ? "webkit"
          : "firefox";
      if (project.browser_version !== manifest.environment.browser_versions[engine]) {
        throw new Error(`${expectedProject} browser version does not match the exact-SHA environment receipt`);
      }
      postgres.add(project.postgresql.identifier_sha256);
      redis.add(project.redis.namespace_sha256);
      profiles.add(project.browser_profile_sha256);
    }
  }
  if (postgres.size !== 10 || redis.size !== 10 || profiles.size !== 10) {
    throw new Error("Gate C C3 reused PostgreSQL, Redis, or browser-profile isolation");
  }
  validateGateCC3PhysicalReceipts(manifest.physical_devices, expectedSourceSha);
  assertNoGateCC3Secrets(manifest);
  return manifest;
}

function exec(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function runLogged(entry, logPath, env = process.env) {
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const child = spawn(entry.command, entry.args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => {
    chunks.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    chunks.push(chunk);
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const bytes = Buffer.concat(chunks);
  assertNoGateCC3SecretText(bytes.toString("utf8"), `${entry.label} log`);
  await writeFile(logPath, bytes, { flag: "wx" });
  if (exitCode !== 0) throw new Error(`${entry.label} exited with code ${String(exitCode)}`);
  const output = bytes.toString("utf8");
  const skippedCount = [...output.matchAll(/\b(\d+)\s+(?:skipped|pending|todo)\b/giu)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  return {
    label: entry.label,
    command: [entry.command, ...entry.args].join(" "),
    exit_code: 0,
    failed_count: 0,
    skipped_count: skippedCount,
    started_at: startedAt.toISOString(),
    duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000,
    log_path: path.relative(root, logPath).split(path.sep).join("/"),
    log_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function verifyAndSealCommandLogs(commands) {
  for (const command of commands) {
    const absolute = path.join(root, command.log_path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Gate C C3 command log is not a retained regular file: ${command.label}`);
    }
    const bytes = await readFile(absolute);
    assertNoGateCC3SecretText(bytes.toString("utf8"), `${command.label} log`);
    if (createHash("sha256").update(bytes).digest("hex") !== command.log_sha256) {
      throw new Error(`Gate C C3 command log changed after collection: ${command.label}`);
    }
    await chmod(absolute, 0o444);
  }
}

async function sealRetainedFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Gate C C3 evidence must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) {
      await sealRetainedFiles(absolute);
      await chmod(absolute, 0o555);
    } else if (entry.isFile()) {
      await chmod(absolute, 0o444);
    }
  }
}

export async function writeAndVerifyTreeSeal(directory, sourceSha) {
  const files = await retainedRelativeFiles(directory);
  if (files.includes("ledger-seal.json")) {
    throw new Error("Gate C C3 ledger seal already exists");
  }
  const entries = await Promise.all(
    files.map(async (relative) => {
      const absolute = path.join(directory, relative);
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Gate C C3 tree seal requires regular files: ${relative}`);
      }
      const bytes = await readFile(absolute);
      return {
        path: relative,
        size_bytes: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const treeSha256 = createHash("sha256").update(canonicalEvidenceJson(entries)).digest("hex");
  const sealPath = path.join(directory, "ledger-seal.json");
  await writeFile(
    sealPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        artifact_kind: "gate-c-c3-ledger-tree-seal",
        source_sha: sourceSha,
        entries,
        tree_sha256: treeSha256,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  for (const entry of entries) {
    const bytes = await readFile(path.join(directory, entry.path));
    if (bytes.byteLength !== entry.size_bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Gate C C3 retained tree changed during final sealing: ${entry.path}`);
    }
  }
  const reopenedSeal = JSON.parse(await readFile(sealPath, "utf8"));
  if (
    reopenedSeal.source_sha !== sourceSha ||
    reopenedSeal.tree_sha256 !== treeSha256 ||
    canonicalEvidenceJson(reopenedSeal.entries) !== canonicalEvidenceJson(entries)
  ) {
    throw new Error("Gate C C3 final tree seal failed its reopen-and-rehash check");
  }
  await sealRetainedFiles(directory);
  await chmod(directory, 0o555);
}

async function readPhysicalReceipt(environmentName, sourceSha) {
  const configured = process.env[environmentName]?.trim();
  if (!configured) throw new Error(`${environmentName} is required; physical-device evidence cannot be skipped`);
  const absolute = path.resolve(root, configured);
  const allowed = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha, "physical");
  const [canonicalAllowed, canonicalFile] = await Promise.all([realpath(allowed), realpath(absolute)]);
  if (!canonicalFile.startsWith(`${canonicalAllowed}${path.sep}`)) {
    throw new Error(`${environmentName} must remain under the exact-SHA physical evidence directory`);
  }
  if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`${environmentName} must not be a symlink`);
  return JSON.parse(await readFile(canonicalFile, "utf8"));
}

export async function verifyGateCC3ArtifactHashes(retainedDirectory, artifacts) {
  const canonicalRoot = await realpath(retainedDirectory);
  for (const artifact of artifacts) {
    const absolute = path.resolve(canonicalRoot, artifact.path);
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Gate C C3 artifact escaped its retained directory: ${artifact.path}`);
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Gate C C3 artifact must be a retained regular file: ${artifact.path}`);
    }
    const canonicalFile = await realpath(absolute);
    if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Gate C C3 artifact traverses a symlink: ${artifact.path}`);
    }
    const bytes = await readFile(canonicalFile);
    assertNoGateCC3SecretText(bytes.toString("utf8"), artifact.path);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 || metadata.size !== artifact.size_bytes) {
      throw new Error(`Gate C C3 artifact hash or size differs from retained bytes: ${artifact.path}`);
    }
  }
  const listedPaths = new Set(artifacts.map((artifact) => artifact.path));
  const unlisted = (await retainedRelativeFiles(canonicalRoot)).filter((relative) => !listedPaths.has(relative));
  for (const relative of unlisted) {
    const bytes = await readFile(path.join(canonicalRoot, relative));
    assertNoGateCC3SecretText(bytes.toString("utf8"), relative);
    let kind = "";
    try {
      kind = JSON.parse(bytes.toString("utf8"))?.artifact_kind ?? "";
    } catch {
      // An unlisted binary or malformed file is never admissible evidence.
    }
    if (!(
      (relative === "project-evidence.json" && kind === "gate-c-c3-project-evidence") ||
      kind === "gate-c-c3-physical-device-receipt"
    )) {
      throw new Error(`Gate C C3 retained file is not hash-bound by the receipt: ${relative}`);
    }
  }
}

async function retainedRelativeFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Gate C C3 evidence must not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...(await retainedRelativeFiles(directory, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

export async function verifyGateCC3ScenarioArtifacts(retainedDirectory, receipt, ownerKind, ownerName) {
  const canonicalRoot = await realpath(retainedDirectory);
  for (const scenario of receipt.scenarios) {
    const artifact = receipt.artifact_hashes.find((candidate) => candidate.sha256 === scenario.receipt_sha256);
    if (!artifact) throw new Error(`${ownerName}/${scenario.scenario} has no retained scenario receipt`);
    const expectedPath = `scenarios/${scenario.scenario}.json`;
    if (artifact.path !== expectedPath) {
      throw new Error(`${ownerName}/${scenario.scenario} receipt has a non-canonical path`);
    }
    const document = JSON.parse(await readFile(path.join(canonicalRoot, artifact.path), "utf8"));
    if (
      document?.artifact_kind !== "gate-c-c3-scenario-receipt" ||
      document?.source_sha !== receipt.source_sha ||
      document?.owner_kind !== ownerKind ||
      document?.owner_name !== ownerName ||
      document?.scenario !== scenario.scenario ||
      document?.status !== "passed" ||
      !Number.isFinite(Date.parse(document?.observed_at ?? "")) ||
      !exactSet(document?.assertions, gateCC3ScenarioAssertions[scenario.scenario]) ||
      !document?.observations ||
      typeof document.observations !== "object" ||
      Array.isArray(document.observations) ||
      !exactSet(Object.keys(document.observations), gateCC3ScenarioObservationKeys[scenario.scenario])
    ) {
      throw new Error(`${ownerName}/${scenario.scenario} scenario receipt is not canonical`);
    }
    assertNoGateCC3Secrets(document);
  }
}

export async function runGateCC3Ledger() {
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  const dirtyBefore = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirtyBefore) throw new Error(`Refusing Gate C C3 ledger on a dirty source tree:\n${dirtyBefore}`);
  if (process.version !== "v24.18.0") throw new Error(`Expected Node v24.18.0, received ${process.version}`);
  if (exec("pnpm", ["--version"]) !== "10.33.0") throw new Error("Expected pnpm 10.33.0");
  const discoveryOutput = exec("pnpm", [
    "--filter",
    "@matchday/web",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.gate-c-c3.config.ts",
    "--list",
  ]);
  validateGateCC3DiscoveryOutput(discoveryOutput);
  const discoveryCounts = Object.fromEntries(
    gateCC3Projects.map((project) => {
      const escaped = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return [project, [...discoveryOutput.matchAll(new RegExp(`\\[${escaped}\\]`, "gu"))].length];
    }),
  );
  exec("docker", [
    "compose",
    "-f",
    "infra/local/compose.yaml",
    "up",
    "-d",
    "--wait",
    ...requiredInfrastructureServices,
  ]);
  const postgresqlVersion = exec("docker", [
    "compose",
    "-f",
    "infra/local/compose.yaml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "matchday",
    "-d",
    "matchday",
    "-Atc",
    "SHOW server_version",
  ]);
  const redisInfo = exec("docker", [
    "compose",
    "-f",
    "infra/local/compose.yaml",
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "INFO",
    "server",
  ]);
  const redisVersion = redisInfo.match(/^redis_version:([^\r\n]+)$/mu)?.[1];
  if (!redisVersion) throw new Error("Unable to determine the Redis version");
  const mailpit = JSON.parse(
    exec("docker", ["compose", "-f", "infra/local/compose.yaml", "ps", "--format", "json", "mailpit"]),
  );
  const mailpitVersion = String(mailpit.Image ?? "").match(/:v?([^:]+)$/u)?.[1];
  if (!mailpitVersion || mailpit.Health !== "healthy") {
    throw new Error("Gate C C3 requires a healthy versioned Mailpit service");
  }
  const playwrightVersion = exec("pnpm", ["--filter", "@matchday/web", "exec", "playwright", "--version"]).replace(
    /^Version\s+/u,
    "",
  );
  const browserVersions = JSON.parse(
    exec("pnpm", [
      "--filter",
      "@matchday/web",
      "exec",
      "node",
      "--input-type=module",
      "-e",
      'import {chromium,firefox,webkit} from "@playwright/test";const c=await chromium.launch({headless:true});const w=await webkit.launch({headless:true});const f=await firefox.launch({headless:true});console.log(JSON.stringify({chromium:c.version(),webkit:w.version(),firefox:f.version()}));await Promise.all([c.close(),w.close(),f.close()]);',
    ]),
  );

  const ledgerId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const shaRoot = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha);
  const directory = path.join(shaRoot, "ledgers", ledgerId);
  const logs = path.join(directory, "logs");
  const runsDirectory = path.join(directory, "runs");
  await mkdir(logs, { recursive: true });
  await mkdir(runsDirectory);
  if (!(await realpath(directory)).startsWith(`${await realpath(shaRoot)}${path.sep}`)) {
    throw new Error("Gate C C3 ledger directory escaped the exact-SHA root");
  }

  const commands = [];
  for (const entry of requiredGateCC3Commands) {
    commands.push(
      await runLogged(entry, path.join(logs, `${entry.label}.log`), {
        ...process.env,
        ...(entry.forceTurbo ? { TURBO_FORCE: "true" } : {}),
        ...(entry.infrastructure ? { RUN_INFRA_TESTS: "1" } : {}),
      }),
    );
  }

  const runs = [];
  for (const runNumber of [1, 2]) {
    const runDirectory = path.join(runsDirectory, `run-${runNumber}`);
    const entry = {
      label: `gate-c-c3-real-${runNumber}`,
      command: "pnpm",
      args: ["test:e2e:gate-c-c3:real"],
    };
    commands.push(
      await runLogged(entry, path.join(logs, `${entry.label}.log`), {
        ...process.env,
        GATE_C_C3_EVIDENCE_DIR: runDirectory,
      }),
    );
    const receipt = JSON.parse(await readFile(path.join(runDirectory, "run-evidence.json"), "utf8"));
    const summaries = validateGateCC3RunReceipt(receipt, sourceSha);
    const projects = [];
    for (const summary of summaries) {
      const project = JSON.parse(await readFile(path.join(runDirectory, summary.evidence_path), "utf8"));
      const validated = validateGateCC3ProjectReceipt(project, sourceSha, summary.project_name, summary.pass_count);
      await verifyGateCC3ArtifactHashes(path.join(runDirectory, summary.project_name), validated.artifact_hashes);
      await verifyGateCC3ScenarioArtifacts(
        path.join(runDirectory, summary.project_name),
        validated,
        "project",
        summary.project_name,
      );
      projects.push(validated);
    }
    runs.push({ run_number: runNumber, projects });
  }

  const physicalDevices = await Promise.all([
    readPhysicalReceipt("GATE_C_C3_IOS_RECEIPT", sourceSha),
    readPhysicalReceipt("GATE_C_C3_ANDROID_RECEIPT", sourceSha),
  ]);
  validateGateCC3PhysicalReceipts(physicalDevices, sourceSha);
  for (const device of physicalDevices) {
    const physicalDirectory = path.join(shaRoot, "physical", device.platform);
    await verifyGateCC3ArtifactHashes(physicalDirectory, device.artifact_hashes);
    await verifyGateCC3ScenarioArtifacts(physicalDirectory, device, "physical_device", device.platform);
    await sealRetainedFiles(physicalDirectory);
  }
  const manifest = {
    schema_version: 1,
    artifact_kind: "gate-c-c3-exact-sha-ledger",
    source_sha: sourceSha,
    environment: {
      operating_system: platform(),
      architecture: arch(),
      node_version: process.version,
      pnpm_version: "10.33.0",
      postgresql_version: postgresqlVersion,
      redis_version: redisVersion,
      mailpit_version: mailpitVersion,
      playwright_version: playwrightVersion,
      browser_versions: browserVersions,
    },
    discovery_counts: discoveryCounts,
    commands,
    runs,
    physical_devices: physicalDevices,
  };
  validateGateCC3Certification(manifest, sourceSha);
  await verifyAndSealCommandLogs(commands);
  await sealRetainedFiles(runsDirectory);
  if (
    exec("git", ["rev-parse", "HEAD"]) !== sourceSha ||
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"])
  ) {
    throw new Error("Gate C C3 ledger changed the exact source tree");
  }
  const manifestPath = path.join(directory, "ledger.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await writeAndVerifyTreeSeal(shaRoot, sourceSha);
  process.stdout.write(`${path.relative(root, manifestPath)}\n`);
  return manifestPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateCC3Ledger().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
