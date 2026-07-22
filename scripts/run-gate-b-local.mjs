#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gateBSecretValues, gateBVerdict, redactGateBEvidence } from "./gate-b-evidence.mjs";

const requiredNode = "24.18.";
const requiredPnpm = "10.33.0";
const root = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputDirectory = path.resolve(root, process.env.GATE_B_QA_OUTPUT_DIR || `artifacts/qa/gate-b/${stamp}`);
const continueAfterFailure = process.argv.includes("--continue-after-failure");

const checks = [
  { id: "runner-self-test", command: "node", args: ["scripts/test-gate-b-evidence.mjs"] },
  { id: "external-evidence-self-test", command: "node", args: ["scripts/test-gate-b-external-evidence.mjs"] },
  { id: "frozen-install", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { id: "clean-outputs", command: "pnpm", args: ["ci:assert-clean-outputs"] },
  { id: "format", command: "pnpm", args: ["format:check"] },
  { id: "lint", command: "pnpm", args: ["lint"] },
  { id: "typecheck", command: "pnpm", args: ["typecheck"] },
  { id: "unit", command: "pnpm", args: ["test:unit"] },
  { id: "migration-check", command: "pnpm", args: ["db:migrate:check"] },
  { id: "backup-restore", command: "pnpm", args: ["backup:verify"] },
  {
    id: "integration",
    command: "pnpm",
    args: ["test:integration"],
    env: { RUN_INFRA_TESTS: "1" },
  },
  { id: "performance", command: "pnpm", args: ["test:performance"] },
  { id: "canonical-fixtures", command: "pnpm", args: ["validate:fixtures"] },
  { id: "phase-2-fixtures", command: "pnpm", args: ["validate:phase2"] },
  { id: "phase-3-fixtures", command: "pnpm", args: ["validate:phase3"] },
  { id: "phase-4-fixtures", command: "pnpm", args: ["validate:phase4"] },
  { id: "openapi", command: "pnpm", args: ["openapi:check"] },
  { id: "dependency-audit", command: "pnpm", args: ["dependencies:audit"] },
  { id: "secret-scan", command: "pnpm", args: ["secrets:scan"] },
  { id: "build", command: "pnpm", args: ["build"] },
  { id: "deployment-manifest", command: "pnpm", args: ["deploy:manifest"] },
  { id: "origin-asset-verification", command: "pnpm", args: ["asset-delivery:verify:origin"] },
  {
    id: "playwright-engines",
    command: "pnpm",
    args: ["--filter", "@matchday/web", "exec", "playwright", "install", "chromium", "webkit"],
  },
  { id: "gate-b-real-e2e-first", command: "pnpm", args: ["test:e2e:phase4:real"] },
  { id: "gate-b-real-e2e-second", command: "pnpm", args: ["test:e2e:phase4:real"] },
  { id: "browser-e2e", command: "pnpm", args: ["test:e2e"] },
  { id: "accessibility", command: "pnpm", args: ["test:a11y"] },
  { id: "visual", command: "pnpm", args: ["test:visual"] },
  { id: "external-evidence", command: "pnpm", args: ["qa:gate-b:external"] },
  { id: "whitespace", command: "git", args: ["diff", "--check"] },
];

async function run(command, args, extraEnvironment = {}) {
  const environment = { ...process.env, ...extraEnvironment };
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    exitCode: exitCode ?? 1,
    output: redactGateBEvidence(Buffer.concat(chunks).toString("utf8"), gateBSecretValues(environment)),
  };
}

async function version(command, args) {
  const result = await run(command, args);
  if (result.exitCode !== 0) throw new Error(`${command} is unavailable`);
  return result.output.trim().split(/\r?\n/, 1)[0] || "unknown";
}

function markdown(summary) {
  const rows = summary.checks
    .map((check) => `| ${check.id} | ${check.status} | ${check.exitCode ?? "—"} | ${check.durationMs} |`)
    .join("\n");
  return `# Gate B local validation\n\n- Commit: \`${summary.commit}\`\n- Started: ${summary.startedAt}\n- Finished: ${summary.finishedAt}\n- Environment: ${summary.platform} ${summary.architecture}\n- Node: ${summary.node}\n- pnpm: ${summary.pnpm}\n- Verdict: **${summary.verdict}**\n- Required checks: ${summary.requiredCount}\n- Passed: ${summary.passedCount}\n- Failed: ${summary.failedCount}\n- Skipped: ${summary.skippedCount}\n\n| Check | Status | Exit | Duration ms |\n|---|---:|---:|---:|\n${rows}\n\nA PASS is valid only when every required check executed and passed, including the commit-bound external evidence bundle. Hosted GitHub Actions were not used.\n`;
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const node = process.version;
  if (!node.startsWith(`v${requiredNode}`)) {
    throw new Error(`Gate B requires Node ${requiredNode}x; received ${node}`);
  }
  const pnpm = await version("pnpm", ["--version"]);
  if (pnpm !== requiredPnpm) throw new Error(`Gate B requires pnpm ${requiredPnpm}; received ${pnpm}`);
  const commit = await version("git", ["rev-parse", "HEAD"]);
  const results = [];
  let blocked = false;

  for (const check of checks) {
    if (blocked && !continueAfterFailure) {
      results.push({ id: check.id, status: "SKIPPED", exitCode: null, durationMs: 0 });
      continue;
    }
    const began = Date.now();
    const result = await run(check.command, check.args, check.env);
    const record = {
      id: check.id,
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      exitCode: result.exitCode,
      durationMs: Date.now() - began,
    };
    results.push(record);
    await writeFile(path.join(outputDirectory, `${check.id}.log`), result.output, { mode: 0o600 });
    process.stdout.write(`${record.status.padEnd(4)} ${check.id} (${record.durationMs} ms)\n`);
    if (result.exitCode !== 0) blocked = true;
  }

  const passedCount = results.filter((item) => item.status === "PASS").length;
  const failedCount = results.filter((item) => item.status === "FAIL").length;
  const skippedCount = results.filter((item) => item.status === "SKIPPED").length;
  const verdict = gateBVerdict(results, checks.length);
  const finishedAt = new Date();
  const summary = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    platform: os.platform(),
    architecture: os.arch(),
    node,
    pnpm,
    commit,
    requiredCount: checks.length,
    passedCount,
    failedCount,
    skippedCount,
    verdict,
    checks: results,
  };
  const canonical = JSON.stringify(summary);
  const evidenceHash = createHash("sha256").update(canonical).digest("hex");
  await writeFile(
    path.join(outputDirectory, "summary.json"),
    `${JSON.stringify({ ...summary, evidenceHash }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(path.join(outputDirectory, "summary.md"), markdown(summary), { mode: 0o600 });
  process.stdout.write(`Gate B local verdict: ${verdict}\nEvidence: ${outputDirectory}\n`);
  if (verdict !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
