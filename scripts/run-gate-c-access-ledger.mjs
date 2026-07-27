#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedProjects = [
  "gate-c-access-phone-chromium",
  "gate-c-access-phone-webkit",
  "gate-c-access-desktop-chromium",
];
const sha256Pattern = /^[a-f0-9]{64}$/u;

function commandOutput(command, args) {
  return BunlessExec(command, args).trim();
}

function BunlessExec(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function cleanStatus() {
  return commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
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
  await writeFile(logPath, Buffer.concat(chunks));
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

async function walk(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Gate C access evidence must not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...(await walk(directory, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function hashFiles(directory) {
  return Promise.all(
    (await walk(directory)).map(async (relativePath) => {
      const absolutePath = path.join(directory, relativePath);
      const [contents, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      return {
        path: relativePath.split(path.sep).join("/"),
        sha256: createHash("sha256").update(contents).digest("hex"),
        size_bytes: metadata.size,
      };
    }),
  );
}

export { hashFiles as hashFilesForTest };

function parseBrowserVersions(output) {
  const versions = JSON.parse(output);
  if (!versions.chromium || !versions.webkit) throw new Error("Playwright browser versions are incomplete");
  return versions;
}

export function validateRunReceipt(receipt, sourceSha) {
  if (
    receipt?.source_sha !== sourceSha ||
    receipt?.pass_count !== expectedProjects.length ||
    !Array.isArray(receipt?.projects) ||
    receipt.projects.length !== expectedProjects.length
  ) {
    throw new Error("Gate C access run emitted an invalid receipt");
  }
  for (const [index, expectedProject] of expectedProjects.entries()) {
    const project = receipt.projects[index];
    if (
      project?.project_name !== expectedProject ||
      project?.pass_count !== 1 ||
      project?.evidence_path !== `${expectedProject}/project-evidence.json` ||
      typeof project?.duration_ms !== "number" ||
      !Number.isFinite(project.duration_ms) ||
      project.duration_ms <= 0
    ) {
      throw new Error(`Gate C access run receipt is invalid for ${expectedProject}`);
    }
  }
  return receipt.projects;
}

export async function runGateCAccessLedger() {
  const sourceSha = commandOutput("git", ["rev-parse", "HEAD"]);
  const dirtyBefore = cleanStatus();
  if (dirtyBefore) throw new Error(`Refusing Gate C access ledger on a dirty source tree:\n${dirtyBefore}`);
  if (process.version !== "v24.18.0") throw new Error(`Expected Node v24.18.0, received ${process.version}`);
  const pnpmVersion = commandOutput("pnpm", ["--version"]);
  if (pnpmVersion !== "10.33.0") throw new Error(`Expected pnpm 10.33.0, received ${pnpmVersion}`);

  BunlessExec("docker", ["compose", "-f", "infra/local/compose.yaml", "up", "-d", "--wait", "postgres", "redis"]);
  const postgresqlVersion = commandOutput("docker", [
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
  const redisInfo = commandOutput("docker", [
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
  if (!redisVersion) throw new Error("Unable to determine the Redis server version");
  const playwrightVersion = commandOutput("pnpm", [
    "--filter",
    "@matchday/web",
    "exec",
    "playwright",
    "--version",
  ]).replace(/^Version\s+/u, "");
  const browserVersions = parseBrowserVersions(
    commandOutput("pnpm", [
      "--filter",
      "@matchday/web",
      "exec",
      "node",
      "--input-type=module",
      "-e",
      'import {chromium,webkit} from "@playwright/test";const c=await chromium.launch({headless:true});const w=await webkit.launch({headless:true});console.log(JSON.stringify({chromium:c.version(),webkit:w.version()}));await c.close();await w.close();',
    ]),
  );

  const ledgerId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const ledgerDirectory = path.join(root, "artifacts", "qa", "gate-c-access", sourceSha, "ledgers", ledgerId);
  await mkdir(path.dirname(ledgerDirectory), { recursive: true });
  await mkdir(ledgerDirectory);
  const logsDirectory = path.join(ledgerDirectory, "logs");
  const runsDirectory = path.join(ledgerDirectory, "runs");
  await mkdir(logsDirectory);
  await mkdir(runsDirectory);

  const commands = [];
  const runs = [];
  const postgresIsolationHashes = new Set();
  const redisNamespaceHashes = new Set();
  for (const runNumber of [1, 2]) {
    const runDirectory = path.join(runsDirectory, `run-${runNumber}`);
    commands.push(
      await runLogged(
        `gate-c-access-real-${runNumber}`,
        "pnpm",
        ["test:e2e:gate-c-access:real"],
        path.join(logsDirectory, `gate-c-access-real-${runNumber}.log`),
        { ...process.env, GATE_C_ACCESS_EVIDENCE_DIR: runDirectory },
      ),
    );
    const receipt = JSON.parse(await readFile(path.join(runDirectory, "run-evidence.json"), "utf8"));
    const projectSummaries = validateRunReceipt(receipt, sourceSha);
    for (const summary of projectSummaries) {
      const projectReceipt = JSON.parse(await readFile(path.join(runDirectory, summary.evidence_path), "utf8"));
      if (
        projectReceipt?.source_sha !== sourceSha ||
        projectReceipt?.project_name !== summary.project_name ||
        projectReceipt?.pass_count !== 1 ||
        !sha256Pattern.test(projectReceipt?.postgresql?.identifier_sha256 ?? "") ||
        !sha256Pattern.test(projectReceipt?.redis?.namespace_sha256 ?? "") ||
        !Number.isSafeInteger(projectReceipt?.redis?.logical_database) ||
        projectReceipt?.redis?.initial_owned_key_count !== 0 ||
        projectReceipt?.redis?.final_owned_key_count !== 0 ||
        projectReceipt?.redis?.unrelated_guard_preserved !== true ||
        !Array.isArray(projectReceipt?.screenshot_paths) ||
        projectReceipt.screenshot_paths.length === 0 ||
        !Array.isArray(projectReceipt?.result_paths) ||
        projectReceipt.result_paths.length === 0
      ) {
        throw new Error(`Gate C access project receipt is invalid for ${summary.project_name}`);
      }
      postgresIsolationHashes.add(projectReceipt.postgresql.identifier_sha256);
      redisNamespaceHashes.add(projectReceipt.redis.namespace_sha256);
    }
    runs.push({
      run_number: runNumber,
      retention_path: path.relative(root, runDirectory).split(path.sep).join("/"),
      receipt,
    });
  }
  if (postgresIsolationHashes.size !== 6 || redisNamespaceHashes.size !== 6) {
    throw new Error("Gate C access ledger did not prove six distinct PostgreSQL and Redis isolations");
  }

  const dirtyAfter = cleanStatus();
  if (dirtyAfter) throw new Error(`Gate C access ledger changed the source tree:\n${dirtyAfter}`);
  const endingSha = commandOutput("git", ["rev-parse", "HEAD"]);
  if (endingSha !== sourceSha) {
    throw new Error(`Gate C access ledger HEAD changed from ${sourceSha} to ${endingSha}`);
  }
  const artifacts = await hashFiles(ledgerDirectory);
  const manifest = {
    schema_version: 1,
    artifact_kind: "gate-c-access-exact-sha-ledger",
    source_sha: sourceSha,
    source_guard: {
      command: "git status --porcelain=v1 --untracked-files=all",
      clean_before: true,
      clean_after: true,
      empty_output_sha256: createHash("sha256").update("", "utf8").digest("hex"),
    },
    environment: {
      node_version: process.version,
      pnpm_version: pnpmVersion,
      postgresql_version: postgresqlVersion,
      redis_version: redisVersion,
      playwright_version: playwrightVersion,
      chromium_version: browserVersions.chromium,
      webkit_version: browserVersions.webkit,
    },
    commands,
    runs,
    artifacts,
  };
  const manifestPath = path.join(ledgerDirectory, "ledger.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${path.relative(root, manifestPath)}\n`);
  return manifestPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateCAccessLedger().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
