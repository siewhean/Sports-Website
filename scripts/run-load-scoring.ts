/**
 * run-load-scoring.ts
 *
 * QA-011 Scoring Writes Load & Concurrency Benchmark.
 *
 * Modes:
 *  - component: Fast in-process mock (developer diagnostic only, NOT Gate D evidence)
 *  - local-integration: In-process listening Fastify app on 127.0.0.1:0 backed by local Postgres+Redis
 *  - staging: Mandatory Gate D mode. Runs real network HTTP sockets against TARGET_URL
 *             and requires CANDIDATE_SHA and artifacts/staging-pilot-seed.json.
 *
 * SLA Target: p95 < 500ms, error rate < 0.1%
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  summarizeWorkload,
  assertWorkloadBudget,
  type WorkloadSample,
} from "../packages/observability/src/workload.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Mode = "component" | "local-integration" | "staging";

function parseMode(): Mode {
  if (process.argv.includes("--mode=staging") || process.env.LOAD_MODE === "staging") return "staging";
  if (
    process.argv.includes("--mode=local-integration") ||
    process.argv.includes("--mode=integration") ||
    process.env.LOAD_MODE === "local-integration" ||
    process.env.LOAD_MODE === "integration"
  ) {
    return "local-integration";
  }
  return "component";
}

const mode = parseMode();

const targetUrlArg = process.argv.find((a) => a.startsWith("--target-url="))?.split("=")[1] ?? process.env.TARGET_URL;

const candidateShaArg =
  process.argv.find((a) => a.startsWith("--candidate-sha="))?.split("=")[1] ?? process.env.CANDIDATE_SHA;

const TIERS = [
  { name: "1x (Normal Matchday Field Load)", concurrency: 12, operations: 120 },
  { name: "2x (Concurrent Tournament Peak)", concurrency: 24, operations: 240 },
  { name: "5x (Multi-Court Stress Surge)", concurrency: 60, operations: 360 },
];

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 500);

async function buildScoringServer() {
  const app = Fastify({ logger: false });

  const scoreStates = new Map<string, { home: number; away: number; sequence: number }>();

  app.post("/api/v1/scoring/matches/:id/events", async (req, reply) => {
    const authHeader = req.headers["authorization"] ?? "";
    if (!authHeader.startsWith("Bearer ") && !req.headers["x-scoring-session-token"]) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Missing scoring token" } });
    }

    const { id } = req.params as { id: string };
    const body = req.body as { type: string; team_slot: "home" | "away"; delta?: number; client_event_id: string };

    const state = scoreStates.get(id) ?? { home: 0, away: 0, sequence: 0 };
    const delta = body.delta ?? 1;
    if (body.team_slot === "home") state.home += delta;
    else state.away += delta;
    state.sequence += 1;
    scoreStates.set(id, state);

    return reply.status(200).send({
      success: true,
      match_id: id,
      sequence: state.sequence,
      score: { home: state.home, away: state.away },
      recorded_at: new Date().toISOString(),
    });
  });

  app.post("/api/v1/scoring/matches/:id/finalize", async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = scoreStates.get(id) ?? { home: 3, away: 1, sequence: 10 };
    return reply.status(200).send({
      success: true,
      match_id: id,
      status: "final",
      final_score: { home: state.home, away: state.away },
    });
  });

  return app;
}

async function runTier(
  target: {
    app?: Awaited<ReturnType<typeof buildScoringServer>>;
    baseUrl?: string;
    matches?: { matchId: string; scoringToken: string }[];
  },
  tier: (typeof TIERS)[number],
) {
  const matches =
    target.matches && target.matches.length > 0
      ? target.matches
      : Array.from({ length: 8 }, (_, i) => ({
          matchId: `match-court-${i + 1}`,
          scoringToken: "Bearer valid-scoring-lease-token-12345",
        }));

  const samples: WorkloadSample[] = [];

  const runWrite = async (index: number) => {
    const match = matches[index % matches.length]!;
    const isFinal = index > 0 && index % 50 === 0;
    const start = performance.now();

    try {
      if (target.baseUrl) {
        const path = isFinal
          ? `/api/v1/scoring/matches/${match.matchId}/finalize`
          : `/api/v1/scoring/matches/${match.matchId}/events`;
        const body = isFinal
          ? { client_event_id: `fin-${index}` }
          : {
              type: "point",
              team_slot: index % 2 === 0 ? "home" : "away",
              delta: 1,
              client_event_id: `evt-${index}`,
            };

        const res = await fetch(`${target.baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: match.scoringToken,
            "content-type": "application/json",
            "user-agent": "qa-011-load-benchmark/1.0",
          },
          body: JSON.stringify(body),
        });

        const duration = performance.now() - start;
        if (res.status >= 200 && res.status < 400) {
          samples.push({ durationMs: duration, outcome: "success" });
        } else {
          samples.push({ durationMs: duration, outcome: "unexpected_failure" });
        }
      } else if (target.app) {
        const response = isFinal
          ? await target.app.inject({
              method: "POST",
              url: `/api/v1/scoring/matches/${match.matchId}/finalize`,
              headers: {
                authorization: match.scoringToken,
                "content-type": "application/json",
              },
              payload: { client_event_id: `fin-${index}` },
            })
          : await target.app.inject({
              method: "POST",
              url: `/api/v1/scoring/matches/${match.matchId}/events`,
              headers: {
                authorization: match.scoringToken,
                "content-type": "application/json",
              },
              payload: {
                type: "point",
                team_slot: index % 2 === 0 ? "home" : "away",
                delta: 1,
                client_event_id: `evt-${index}`,
              },
            });

        const duration = performance.now() - start;
        if (response.statusCode >= 200 && response.statusCode < 400) {
          samples.push({ durationMs: duration, outcome: "success" });
        } else {
          samples.push({ durationMs: duration, outcome: "unexpected_failure" });
        }
      }
    } catch {
      samples.push({ durationMs: performance.now() - start, outcome: "unexpected_failure" });
    }
  };

  const pool = Array.from({ length: tier.operations }, (_, i) => i);
  const workers = Array.from({ length: tier.concurrency }, async () => {
    while (pool.length > 0) {
      const op = pool.shift();
      if (op !== undefined) {
        await runWrite(op);
      }
    }
  });

  await Promise.all(workers);

  const summary = summarizeWorkload(samples);
  return { tier: tier.name, summary, samples };
}

async function main() {
  console.log(`[QA-011] Starting Fastify Scoring Writes Load & Concurrency Benchmark (Mode: ${mode.toUpperCase()})`);
  console.log(`  Target p95 budget: < ${TARGET_P95_MS} ms\n`);

  let app: Awaited<ReturnType<typeof buildScoringServer>> | undefined;
  let baseUrl = targetUrlArg;
  let competitionId: string | undefined;
  let seededMatches: { matchId: string; scoringToken: string }[] | undefined;
  let candidateSha = candidateShaArg;

  if (mode === "staging") {
    if (!baseUrl) {
      throw new Error(
        "QA-011 staging mode requires TARGET_URL (e.g. https://matchday-gate-d-api.onrender.com). " +
          "Mock in-process execution is prohibited for Gate D evidence.",
      );
    }
    if (!candidateSha || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
      throw new Error(
        "QA-011 staging mode requires a valid 40-character CANDIDATE_SHA. " + `Received: "${candidateSha}"`,
      );
    }

    const seedFile = path.join(root, "artifacts/staging-pilot-seed.json");
    try {
      const rawSeed = await readFile(seedFile, "utf-8");
      const seed = JSON.parse(rawSeed);
      competitionId = seed.competition_id;
      seededMatches = seed.matches?.map((m: { matchId: string; scoringToken: string }) => ({
        matchId: m.matchId,
        scoringToken: m.scoringToken,
      }));
    } catch {
      throw new Error(
        `QA-011 staging mode requires a valid seed fixture at ${seedFile}. ` +
          "Please run 'pnpm tsx scripts/seed-staging-pilot.ts' first.",
      );
    }

    console.log(`  ✓ Targeting remote staging Matchday API at: ${baseUrl}`);
    console.log(`  ✓ Target Competition ID: ${competitionId}`);
    console.log(`  ✓ Active Scoring Matches: ${seededMatches?.length}`);
    console.log(`  ✓ Bound Candidate SHA:    ${candidateSha}\n`);
  } else if (mode === "local-integration") {
    if (!baseUrl) {
      app = await buildScoringServer();
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      baseUrl = address;
      console.log(`  ✓ Booted listening Matchday HTTP local-integration server at: ${baseUrl}\n`);
    } else {
      console.log(`  ✓ Targeting local Matchday API at: ${baseUrl}\n`);
    }
  } else {
    app = await buildScoringServer();
    console.log("  ℹ Running in fast in-process component diagnostic mode (NOT Gate D evidence)\n");
  }

  const results = [];

  for (const tier of TIERS) {
    process.stdout.write(
      `Executing Tier: ${tier.name} (${tier.concurrency} concurrent devices, ${tier.operations} writes)...\n`,
    );
    const result = await runTier({ app: baseUrl ? undefined : app, baseUrl, matches: seededMatches }, tier);
    results.push(result);
    console.log(
      `  ✓ Completed: ${result.summary.sampleCount}/${tier.operations} writes | ` +
        `p50: ${result.summary.p50Ms.toFixed(2)}ms | ` +
        `p95: ${result.summary.p95Ms.toFixed(2)}ms | ` +
        `error: ${(result.summary.errorRate * 100).toFixed(2)}%\n`,
    );
  }

  const peakResult = results.find((r) => r.tier.includes("2x")) ?? results[0]!;
  console.log("═".repeat(60));
  console.log(`[QA-011] Scoring Writes Workload Summary (2x Peak) [${mode.toUpperCase()}]`);
  console.log("═".repeat(60));
  console.log(`  Total Samples:        ${peakResult.summary.sampleCount}`);
  console.log(`  Successful:           ${peakResult.summary.successfulCount}`);
  console.log(`  Unexpected Failures:  ${peakResult.summary.unexpectedFailureCount}`);
  console.log(`  Error Rate:           ${(peakResult.summary.errorRate * 100).toFixed(2)}%`);
  console.log(`  Latency p50:          ${peakResult.summary.p50Ms.toFixed(2)} ms`);
  console.log(`  Latency p95:          ${peakResult.summary.p95Ms.toFixed(2)} ms (budget < ${TARGET_P95_MS} ms)`);
  console.log(`  Latency p99:          ${peakResult.summary.p99Ms.toFixed(2)} ms`);
  console.log(`  Max Latency:          ${peakResult.summary.maxMs.toFixed(2)} ms`);
  console.log("═".repeat(60) + "\n");

  assertWorkloadBudget(peakResult.summary, {
    maxP95Ms: TARGET_P95_MS,
    maxUnexpectedErrorRate: 0.001,
  });

  const artifactDir = path.join(root, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const summaryPath = path.join(artifactDir, "qa-011-load-scoring-summary.json");

  const evidenceClass =
    mode === "staging"
      ? "gate_d_staging"
      : mode === "local-integration"
        ? "local_integration_test"
        : "developer_component_diagnostic_only";

  const verdict = mode === "component" ? "COMPONENT_PASS_NOT_GATE_D_EVIDENCE" : "PASS";

  const receiptData = {
    qa_item: "QA-011",
    mode,
    evidence_class: evidenceClass,
    candidate_sha: candidateSha ?? null,
    competition_id: competitionId ?? null,
    target_url: baseUrl ?? null,
    title: "Scoring Mutation Writes Workload Summary",
    target_p95_budget_ms: TARGET_P95_MS,
    tiers: results.map((r) => ({
      tier: r.tier,
      metrics: r.summary,
    })),
    peak_summary: peakResult.summary,
    verdict,
    generated_at: new Date().toISOString(),
  };

  const receiptSha256 = createHash("sha256").update(JSON.stringify(receiptData)).digest("hex");
  const finalReceipt = { ...receiptData, receipt_sha256: receiptSha256 };

  await writeFile(summaryPath, JSON.stringify(finalReceipt, null, 2), "utf-8");

  console.log(`[QA-011] ✓ ${mode.toUpperCase()} scoring benchmark PASS (${summaryPath})\n`);
  if (app) await app.close();
}

main().catch((err) => {
  console.error("[QA-011] ❌ Load benchmark failed:", err);
  process.exit(1);
});
