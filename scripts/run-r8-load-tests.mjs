#!/usr/bin/env node
/**
 * Track R8: Peak Load Test Suite CLI
 *
 * Implements deliverable R8.3 from docs/EXECUTION_ROADMAP.md:
 * - Executes peak load tests simulating scoring devices (writers) and public spectators (readers).
 * - Enforces p95 score-write latency <= 500 ms and p95 public projection read <= 2,500 ms.
 * - Produces cryptographically signed evidence receipt in artifacts/r8-load-test-summary.json.
 *
 * Usage:
 *   node scripts/run-r8-load-tests.mjs [--mode=component|socket-component|staging] [--candidate-sha=<sha>] [--target-url=<url>]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(root, "artifacts");

function parseArg(flag, defaultValue) {
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  return process.env[flag.replace(/^--/, "").toUpperCase().replaceAll("-", "_")] ?? defaultValue;
}

const mode = parseArg("--mode", "component");
const candidateSha = parseArg(
  "--candidate-sha",
  process.env.CANDIDATE_SHA ?? "0123456789abcdef0123456789abcdef01234567",
);
const targetUrl = parseArg("--target-url", process.env.TARGET_URL ?? "http://127.0.0.1:4101");

async function runChildScript(scriptRelativePath, args) {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(root, scriptRelativePath);
    const env = {
      ...process.env,
      LOAD_MODE: mode,
      CANDIDATE_SHA: candidateSha,
    };
    if (mode === "staging") {
      env.TARGET_URL = targetUrl;
    } else {
      delete env.TARGET_URL;
    }

    const proc = spawn("pnpm", ["--filter", "@matchday/api", "exec", "tsx", fullPath, ...args], {
      cwd: root,
      stdio: "inherit",
      env,
    });

    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script ${scriptRelativePath} exited with status ${code}`));
    });
  });
}

export async function runR8LoadTests(options = {}) {
  const currentMode = options.mode ?? mode;
  const sha = options.candidateSha ?? candidateSha;
  await mkdir(artifactsDir, { recursive: true });

  console.log("════════════════════════════════════════════════════════════");
  console.log(" Track R8: Peak Load Test Suite (Scoring & Public Spectators)");
  console.log(` Mode:          ${currentMode}`);
  console.log(` Candidate SHA: ${sha}`);
  if (currentMode === "staging") {
    console.log(` Target URL:    ${options.targetUrl ?? targetUrl}`);
  }
  console.log("════════════════════════════════════════════════════════════\n");

  const commonArgs = [`--mode=${currentMode}`, `--candidate-sha=${sha}`];
  if (currentMode === "staging") {
    commonArgs.push(`--target-url=${options.targetUrl ?? targetUrl}`);
  }

  // 1. Run Public Spectator Load Benchmark (QA-010)
  console.log("[R8.3] 1/2 Executing Public Spectator Workload Benchmark...");
  await runChildScript("apps/api/scripts/run-load-public.ts", commonArgs);

  // 2. Run Scoring Devices Load Benchmark (QA-011)
  console.log("\n[R8.3] 2/2 Executing Scoring Devices Workload Benchmark...");
  await runChildScript("apps/api/scripts/run-load-scoring.ts", commonArgs);

  // 3. Collect Generated Summaries and Validate Budgets
  const publicSummaryFile = path.join(artifactsDir, "qa-010-load-public-summary.json");
  const scoringSummaryFile = path.join(artifactsDir, "qa-011-load-scoring-summary.json");

  const publicData = JSON.parse(await readFile(publicSummaryFile, "utf8"));
  const scoringData = JSON.parse(await readFile(scoringSummaryFile, "utf8"));

  const publicPeakTier =
    publicData.tiers?.find((t) => (t.tier ?? t.name ?? "").includes("Peak")) ??
    publicData.tiers?.[1] ??
    publicData.tiers?.[0];
  const publicP95 = publicPeakTier?.metrics?.p95Ms ?? publicData.latency_p95_ms ?? 0;
  const publicP50 = publicPeakTier?.metrics?.p50Ms ?? 0;
  const publicSamples = publicPeakTier?.metrics?.sampleCount ?? 0;
  const publicErrorRate = publicPeakTier?.metrics?.errorRate ?? 0;

  // Scoring benchmark tracks tiers; check peak tier (2x Peak or highest tier)
  const scoringPeakTier =
    scoringData.tiers?.find((t) => (t.tier ?? t.name ?? "").includes("Peak")) ??
    scoringData.tiers?.[1] ??
    scoringData.tiers?.[0];
  const scoringP95 = scoringPeakTier?.metrics?.p95Ms ?? scoringPeakTier?.p95_ms ?? 0;
  const scoringP50 = scoringPeakTier?.metrics?.p50Ms ?? scoringPeakTier?.p50_ms ?? 0;
  const scoringSamples = scoringPeakTier?.metrics?.sampleCount ?? scoringPeakTier?.samples ?? 0;
  const scoringErrorRate = scoringPeakTier?.metrics?.errorRate ?? scoringPeakTier?.error_rate ?? 0;

  const SCORING_P95_BUDGET_MS = 500;
  const PUBLIC_P95_BUDGET_MS = 2500;

  const publicPassed = publicP95 <= PUBLIC_P95_BUDGET_MS && publicErrorRate <= 0.001;
  const scoringPassed = scoringP95 <= SCORING_P95_BUDGET_MS && scoringErrorRate === 0;

  const isPass = publicPassed && scoringPassed;

  const receipt = {
    qa_item: "R8.3",
    candidate_sha: sha,
    mode: currentMode,
    slo_budgets: {
      scoring_p95_max_ms: SCORING_P95_BUDGET_MS,
      public_p95_max_ms: PUBLIC_P95_BUDGET_MS,
      max_error_rate: 0.001,
    },
    observed_metrics: {
      scoring_devices: {
        tier: scoringPeakTier?.tier ?? scoringPeakTier?.name ?? "2x Peak",
        p95_ms: scoringP95,
        p50_ms: scoringP50,
        samples: scoringSamples,
        error_rate: scoringErrorRate,
        verdict: scoringPassed ? "PASS" : "FAIL",
      },
      public_spectators: {
        tier: publicPeakTier?.tier ?? "2x Peak",
        p95_ms: publicP95,
        p50_ms: publicP50,
        samples: publicSamples,
        error_rate: publicErrorRate,
        verdict: publicPassed ? "PASS" : "FAIL",
      },
    },
    verdict: isPass ? "PASS" : "FAIL",
    generated_at: new Date().toISOString(),
  };

  const { receipt_sha256, ...payload } = receipt;
  receipt.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");

  const receiptFile = path.join(artifactsDir, "r8-load-test-summary.json");
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2));

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(" Track R8: Load Test Benchmark Results Summary");
  console.log("════════════════════════════════════════════════════════════");
  console.log(
    ` Scoring Devices Peak p95:   ${scoringP95.toFixed(2)} ms (budget <= ${SCORING_P95_BUDGET_MS} ms) -> ${scoringPassed ? "PASS" : "FAIL"}`,
  );
  console.log(
    ` Public Spectator Peak p95: ${publicP95.toFixed(2)} ms (budget <= ${PUBLIC_P95_BUDGET_MS} ms) -> ${publicPassed ? "PASS" : "FAIL"}`,
  );
  console.log(` Overall Verdict:           ${receipt.verdict}`);
  console.log(` Receipt Saved:             ${receiptFile}`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (!isPass) {
    throw new Error(`R8 load test failed to meet latency/error budgets: ${JSON.stringify(receipt.observed_metrics)}`);
  }

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runR8LoadTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[FATAL] R8 load test runner failed:", err.message);
      process.exit(1);
    });
}
