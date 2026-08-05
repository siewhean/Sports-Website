#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashFilesForTest,
  requiredInfrastructureServices,
  requiredLocalCommands,
} from "./run-gate-c-access-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projects = ["gate-c-c2-phone-chromium", "gate-c-c2-phone-webkit", "gate-c-c2-desktop-chromium"];
const sha256Pattern = /^[a-f0-9]{64}$/u;
const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"];
const screenshotStems = sports.flatMap((sport) => [
  `${sport.replaceAll("_", "-")}-live-scorer`,
  `${sport.replaceAll("_", "-")}-organiser-audit`,
]);
const browserSteps = [
  "match_started",
  "sport_action",
  "idempotent_replay",
  "sport_completion",
  "finalised",
  "organiser_reopen",
  "organiser_correction",
  "organiser_reopen",
  "refinalised",
  "audit_review",
];
const actionEventTypes = {
  canoe_polo: "goal",
  badminton: "point",
  table_tennis: "point",
  volleyball: "point",
  basketball: "three_point_score",
};

function validSegmentState(value, sportId, winner) {
  try {
    const segments = JSON.parse(value);
    if (!Array.isArray(segments) || segments.length !== 1) return false;
    const segment = segments[0];
    const awayWon = winner === "away";
    const score = sportId === "basketball" ? 3 : 1;
    const segmented = ["badminton", "table_tennis", "volleyball"].includes(sportId);
    return (
      Object.keys(segment).sort().join(",") === "away,completed,home,number,winner" &&
      segment.number === 1 &&
      segment.home === (awayWon ? 0 : score) &&
      segment.away === (awayWon ? score : 0) &&
      segment.completed === segmented &&
      segment.winner === (segmented ? winner : null)
    );
  } catch {
    return false;
  }
}

export function validateSemanticReceipt(receipt, expectedProject) {
  const browserSports = receipt?.browser?.sports;
  const databaseSports = receipt?.database?.sports;
  const browserMultiDivision = receipt?.browser?.multi_division;
  const databaseMultiDivision = receipt?.database?.multi_division;
  if (
    receipt?.artifact_kind !== "gate-c-c2-semantic-oracle" ||
    receipt?.project_name !== expectedProject ||
    receipt?.browser?.artifact_kind !== "gate-c-c2-browser-oracle" ||
    receipt?.browser?.project_name !== expectedProject ||
    !Array.isArray(browserSports) ||
    browserSports.length !== sports.length ||
    !Array.isArray(databaseSports) ||
    databaseSports.length !== sports.length ||
    receipt?.database?.downstream_conflicts?.created !== 1 ||
    receipt?.database?.downstream_conflicts?.acknowledged !== 1 ||
    !receipt?.database?.downstream_conflicts?.corrected_match_id ||
    !receipt?.database?.downstream_conflicts?.downstream_match_id ||
    receipt?.database?.downstream_conflicts?.corrected_match_id ===
      receipt?.database?.downstream_conflicts?.downstream_match_id ||
    receipt?.database?.downstream_conflicts?.result_version !== 2 ||
    receipt?.database?.downstream_conflicts?.reason !== "downstream_match_started" ||
    receipt?.database?.downstream_conflicts?.acknowledgement_actor_present !== true ||
    receipt?.database?.downstream_conflicts?.acknowledgement_reason !==
      "Reviewed against the corrected official result" ||
    !["result_conflict.created", "result_conflict.acknowledged"].every((action) =>
      receipt?.database?.downstream_conflicts?.audit_actions?.includes(action),
    ) ||
    !["result_conflict.created", "result_conflict.acknowledged"].every((eventType) =>
      receipt?.database?.downstream_conflicts?.outbox_event_types?.includes(eventType),
    ) ||
    !browserMultiDivision?.competition_id ||
    browserMultiDivision.primary_division_id === browserMultiDivision.secondary_division_id ||
    browserMultiDivision.primary_result_versions?.join(",") !== "1,3,4" ||
    browserMultiDivision.secondary_result_versions?.join(",") !== "2" ||
    browserMultiDivision.public_packages_visible !== true ||
    browserMultiDivision.cross_division_names_absent !== true ||
    databaseMultiDivision?.competition_id !== browserMultiDivision.competition_id ||
    databaseMultiDivision?.division_ids?.join(",") !==
      [browserMultiDivision.primary_division_id, browserMultiDivision.secondary_division_id].join(",") ||
    databaseMultiDivision?.global_result_versions?.join(",") !== "1,2,3,4" ||
    databaseMultiDivision?.primary_result_versions?.join(",") !== "1,3,4" ||
    databaseMultiDivision?.secondary_result_versions?.join(",") !== "2" ||
    databaseMultiDivision?.public_division_count !== 2 ||
    databaseMultiDivision?.cross_division_reference_count !== 0
  ) {
    throw new Error(`Gate C C2 semantic oracle is invalid for ${expectedProject}`);
  }
  for (const [index, sportId] of sports.entries()) {
    const browser = browserSports[index];
    const database = databaseSports[index];
    const expectedResultVersions = sportId === "badminton" ? "1,3,4" : "1,2,3";
    const expectedPublicationVersion = sportId === "badminton" ? 4 : 3;
    const expectedCorrectionVersion = sportId === "badminton" ? 3 : 2;
    const expectedSequence = Array.from({ length: database?.row_count ?? 0 }, (_, eventIndex) => eventIndex + 1);
    if (
      browser?.sport_id !== sportId ||
      browser?.action_event_type !== actionEventTypes[sportId] ||
      browser?.steps?.join(",") !== browserSteps.join(",") ||
      browser?.observed_result_versions?.join(",") !== expectedResultVersions ||
      !Number.isSafeInteger(browser?.observed_audit_event_count) ||
      browser.observed_audit_event_count < 1 ||
      !browser?.displayed_result?.includes(`0–${sportId === "basketball" ? 3 : 1}`) ||
      database?.sport_id !== sportId ||
      database?.row_count < 8 ||
      database?.distinct_client_event_count !== database?.row_count ||
      database?.sequences?.join(",") !== expectedSequence.join(",") ||
      database?.aggregate_versions?.join(",") !== expectedSequence.join(",") ||
      database?.result_versions?.join(",") !== expectedResultVersions ||
      database?.result_states?.join(",") !== "final,corrected,final" ||
      database?.result_scores?.join(",") !==
        [
          `${sportId === "basketball" ? 3 : 1}:0`,
          `0:${sportId === "basketball" ? 3 : 1}`,
          `0:${sportId === "basketball" ? 3 : 1}`,
        ].join(",") ||
      database?.result_winners?.join(",") !== "home,away,away" ||
      database?.result_lifecycles?.join(",") !== "finalised,finalised,finalised" ||
      !validSegmentState(database?.result_segment_states?.[0], sportId, "home") ||
      !validSegmentState(database?.result_segment_states?.[1], sportId, "away") ||
      !validSegmentState(database?.result_segment_states?.[2], sportId, "away") ||
      database?.publication_result_version !== expectedPublicationVersion ||
      database?.correction_transactions !== 1 ||
      database?.correction_from_version < 1 ||
      database?.correction_through_version <= database?.correction_from_version ||
      database?.correction_result_version !== expectedCorrectionVersion ||
      database?.result_through_sequences?.join(",") !==
        [database?.correction_from_version - 1, database?.correction_through_version, database?.row_count].join(",") ||
      database?.stream_sport_code !== sportId ||
      !database?.stream_pack_version ||
      !sha256Pattern.test(database?.settings_fingerprint ?? "") ||
      database?.stream_current_version !== database?.row_count ||
      database?.reversal_target_count !== 1 ||
      database?.reasoned_reversal_count !== 1 ||
      database?.valid_actor_count !== database?.row_count ||
      ![
        "match_started",
        actionEventTypes[sportId],
        ...(sportId === "badminton" || sportId === "table_tennis"
          ? ["game_completion"]
          : sportId === "volleyball"
            ? ["set_completion"]
            : []),
        "finalisation",
        "match_reopened",
        "reversal",
      ].every((eventType) => database?.event_types?.includes(eventType)) ||
      !["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"].every((action) =>
        database?.audit_actions?.includes(action),
      ) ||
      !["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"].every((eventType) =>
        database?.outbox_event_types?.includes(eventType),
      )
    ) {
      throw new Error(`Gate C C2 semantic oracle is incomplete for ${sportId}`);
    }
  }
  return true;
}

function exec(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function cleanStatus() {
  return exec("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
}

export function validateC2DiscoveryOutput(output) {
  let total = 0;
  for (const project of projects) {
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const count = [...output.matchAll(new RegExp(`\\[${escaped}\\]`, "gu"))].length;
    if (count < 1) throw new Error(`Gate C C2 ledger discovered no tests for ${project}`);
    total += count;
  }
  const reported = Number(output.match(/Total:\s+(\d+)\s+tests?/u)?.[1] ?? "0");
  if (reported !== total) throw new Error("Gate C C2 ledger discovery total is inconsistent");
  return total;
}

export function validateC2ScreenshotPaths(paths) {
  if (!Array.isArray(paths) || !paths.every((item) => typeof item === "string")) {
    throw new Error("Gate C C2 screenshot receipt is missing");
  }
  for (const stem of screenshotStems) {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const matches = paths.filter((item) =>
      new RegExp(`(?:^|/)${escaped}(?:-[a-f0-9]{40,64})?\\.png$`, "u").test(item.replaceAll("\\", "/")),
    );
    if (matches.length !== 1) {
      throw new Error(`Gate C C2 screenshot receipt requires exactly one ${stem} image; found ${matches.length}`);
    }
  }
  return paths;
}

async function runLogged(label, command, args, logPath, env = process.env) {
  const startedAt = new Date();
  const startedAtNanoseconds = process.hrtime.bigint();
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
  await writeFile(logPath, Buffer.concat(chunks), { flag: "wx" });
  const durationMs = Number(process.hrtime.bigint() - startedAtNanoseconds) / 1_000_000;
  if (exitCode !== 0) throw new Error(`${label} exited with code ${String(exitCode)}`);
  return {
    label,
    command: [command, ...args].join(" "),
    exit_code: exitCode,
    started_at: startedAt.toISOString(),
    duration_ms: durationMs,
    log_path: path.relative(root, logPath).split(path.sep).join("/"),
  };
}

async function hashFile(file) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Gate C C2 immutable evidence must be a regular file: ${file}`);
  }
  const contents = await readFile(file);
  return {
    sha256: createHash("sha256").update(contents).digest("hex"),
    size_bytes: metadata.size,
  };
}

export function validateC2RunReceipt(receipt, sourceSha) {
  if (
    receipt?.artifact_kind !== "gate-c-c2-run-evidence" ||
    receipt?.source_sha !== sourceSha ||
    !Array.isArray(receipt?.projects) ||
    receipt.projects.length !== projects.length
  ) {
    throw new Error("Gate C C2 run emitted an invalid receipt");
  }
  let passCount = 0;
  for (const [index, projectName] of projects.entries()) {
    const project = receipt.projects[index];
    if (
      project?.project_name !== projectName ||
      !Number.isSafeInteger(project?.pass_count) ||
      project.pass_count < 1 ||
      project?.evidence_path !== `${projectName}/project-evidence.json` ||
      typeof project?.duration_ms !== "number" ||
      !Number.isFinite(project.duration_ms) ||
      project.duration_ms <= 0
    ) {
      throw new Error(`Gate C C2 run receipt is invalid for ${projectName}`);
    }
    passCount += project.pass_count;
  }
  if (receipt.pass_count !== passCount) throw new Error("Gate C C2 run aggregate pass count is invalid");
  return receipt.projects;
}

export async function immutableFileReceipt(file) {
  return hashFile(file);
}

export async function runGateCC2Ledger() {
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  const dirtyBefore = cleanStatus();
  if (dirtyBefore) throw new Error(`Refusing Gate C C2 ledger on a dirty source tree:\n${dirtyBefore}`);
  if (process.version !== "v24.18.0") throw new Error(`Expected Node v24.18.0, received ${process.version}`);
  const pnpmVersion = exec("pnpm", ["--version"]);
  if (pnpmVersion !== "10.33.0") throw new Error(`Expected pnpm 10.33.0, received ${pnpmVersion}`);
  validateC2DiscoveryOutput(
    exec("pnpm", [
      "--filter",
      "@matchday/web",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.gate-c-c2.config.ts",
      "--list",
    ]),
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
  if (!redisVersion) throw new Error("Unable to determine Redis version");
  const mailpit = JSON.parse(
    exec("docker", ["compose", "-f", "infra/local/compose.yaml", "ps", "--format", "json", "mailpit"]),
  );
  const mailpitVersion = String(mailpit.Image ?? "").match(/:v?([^:]+)$/u)?.[1];
  if (!mailpitVersion || mailpit.Health !== "healthy") {
    throw new Error("Gate C C2 requires a versioned healthy Mailpit service");
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
      'import {chromium,webkit} from "@playwright/test";const c=await chromium.launch({headless:true});const w=await webkit.launch({headless:true});console.log(JSON.stringify({chromium:c.version(),webkit:w.version()}));await c.close();await w.close();',
    ]),
  );
  if (!browserVersions.chromium || !browserVersions.webkit) {
    throw new Error("Gate C C2 browser versions are incomplete");
  }

  const ledgerId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const shaRoot = path.join(root, "artifacts", "qa", "gate-c-c2", sourceSha);
  const ledgerDirectory = path.join(shaRoot, "ledgers", ledgerId);
  const logsDirectory = path.join(ledgerDirectory, "logs");
  const runsDirectory = path.join(ledgerDirectory, "runs");
  const bundlesDirectory = path.join(shaRoot, "bundles");
  await mkdir(logsDirectory, { recursive: true });
  await mkdir(runsDirectory);
  await mkdir(bundlesDirectory, { recursive: true });

  const commands = [];
  const runs = [];
  const postgresHashes = new Set();
  const redisHashes = new Set();
  for (const entry of requiredLocalCommands) {
    commands.push(
      await runLogged(entry.label, entry.command, entry.args, path.join(logsDirectory, `${entry.label}.log`), {
        ...process.env,
        ...(entry.forceTurbo ? { TURBO_FORCE: "true" } : {}),
        ...(entry.infrastructure ? { RUN_INFRA_TESTS: "1" } : {}),
      }),
    );
  }
  for (const runNumber of [1, 2]) {
    const runDirectory = path.join(runsDirectory, `run-${runNumber}`);
    commands.push(
      await runLogged(
        `gate-c-c2-real-${runNumber}`,
        "pnpm",
        ["test:e2e:gate-c-c2:real"],
        path.join(logsDirectory, `gate-c-c2-real-${runNumber}.log`),
        { ...process.env, GATE_C_C2_EVIDENCE_DIR: runDirectory },
      ),
    );
    const receipt = JSON.parse(await readFile(path.join(runDirectory, "run-evidence.json"), "utf8"));
    const summaries = validateC2RunReceipt(receipt, sourceSha);
    for (const summary of summaries) {
      const projectReceipt = JSON.parse(await readFile(path.join(runDirectory, summary.evidence_path), "utf8"));
      if (
        projectReceipt?.artifact_kind !== "gate-c-c2-project-evidence" ||
        projectReceipt?.source_sha !== sourceSha ||
        projectReceipt?.project_name !== summary.project_name ||
        projectReceipt?.pass_count !== summary.pass_count ||
        !sha256Pattern.test(projectReceipt?.postgresql?.identifier_sha256 ?? "") ||
        !sha256Pattern.test(projectReceipt?.redis?.namespace_sha256 ?? "") ||
        !Number.isSafeInteger(projectReceipt?.redis?.logical_database) ||
        projectReceipt?.redis?.initial_owned_key_count !== 0 ||
        projectReceipt?.redis?.final_owned_key_count !== 0 ||
        projectReceipt?.redis?.unrelated_guard_preserved !== true ||
        !validateSemanticReceipt(projectReceipt?.semantic_oracle, summary.project_name) ||
        !validateC2ScreenshotPaths(projectReceipt?.screenshot_paths) ||
        !Array.isArray(projectReceipt?.result_paths) ||
        projectReceipt.result_paths.length === 0
      ) {
        throw new Error(`Gate C C2 project receipt is invalid for ${summary.project_name}`);
      }
      postgresHashes.add(projectReceipt.postgresql.identifier_sha256);
      redisHashes.add(projectReceipt.redis.namespace_sha256);
    }
    runs.push({
      run_number: runNumber,
      retention_path: path.relative(root, runDirectory).split(path.sep).join("/"),
      receipt,
    });
  }
  if (postgresHashes.size !== 6 || redisHashes.size !== 6) {
    throw new Error("Gate C C2 ledger did not prove six distinct PostgreSQL and Redis isolations");
  }

  const dirtyAfter = cleanStatus();
  if (dirtyAfter) throw new Error(`Gate C C2 ledger changed the source tree:\n${dirtyAfter}`);
  const endingSha = exec("git", ["rev-parse", "HEAD"]);
  if (endingSha !== sourceSha) throw new Error(`Gate C C2 ledger HEAD changed from ${sourceSha} to ${endingSha}`);
  commands.push(
    await runLogged(
      "source-clean",
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      path.join(logsDirectory, "source-clean.log"),
    ),
  );
  const artifacts = await hashFilesForTest(ledgerDirectory);
  const ledger = {
    schema_version: 1,
    artifact_kind: "gate-c-c2-exact-sha-ledger",
    source_sha: sourceSha,
    source_guard: {
      command: "git status --porcelain=v1 --untracked-files=all",
      clean_before: true,
      clean_after: true,
      empty_output_sha256: createHash("sha256").update("").digest("hex"),
    },
    environment: {
      operating_system: platform(),
      architecture: arch(),
      node_version: process.version,
      pnpm_version: pnpmVersion,
      postgresql_version: postgresqlVersion,
      redis_version: redisVersion,
      mailpit_version: mailpitVersion,
      mailpit_health: mailpit.Health,
      playwright_version: playwrightVersion,
      chromium_version: browserVersions.chromium,
      webkit_version: browserVersions.webkit,
    },
    commands,
    runs,
    artifacts,
  };
  const ledgerPath = path.join(ledgerDirectory, "ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });

  const bundlePath = path.join(bundlesDirectory, `${ledgerId}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", bundlePath, "-C", ledgerDirectory, "."], {
    cwd: root,
    encoding: "utf8",
  });
  if (tar.status !== 0) throw new Error(`Gate C C2 bundle creation failed: ${(tar.stderr || tar.stdout).trim()}`);
  await chmod(bundlePath, 0o444);
  const [ledgerFile, bundleFile] = await Promise.all([hashFile(ledgerPath), hashFile(bundlePath)]);
  const bundleReceiptPath = path.join(bundlesDirectory, `${ledgerId}.receipt.json`);
  await writeFile(
    bundleReceiptPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        artifact_kind: "gate-c-c2-immutable-bundle",
        source_sha: sourceSha,
        ledger_path: path.relative(root, ledgerPath).split(path.sep).join("/"),
        ledger_sha256: ledgerFile.sha256,
        ledger_size_bytes: ledgerFile.size_bytes,
        bundle_path: path.relative(root, bundlePath).split(path.sep).join("/"),
        bundle_sha256: bundleFile.sha256,
        bundle_size_bytes: bundleFile.size_bytes,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o444 },
  );
  process.stdout.write(`${path.relative(root, bundleReceiptPath)}\n`);
  return bundleReceiptPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateCC2Ledger().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
