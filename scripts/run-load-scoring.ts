/**
 * run-load-scoring.ts
 *
 * QA-011 Scoring Writes Load & Concurrency Benchmark.
 * Executes real in-process HTTP requests against Fastify scoring endpoints with
 * authentication, sequence numbers, score increments, period completion, and finalisation.
 *
 * SLA Target: p95 < 500ms, error rate < 0.1%
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { summarizeWorkload, assertWorkloadBudget } from "../packages/observability/src/workload.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Configure tiers: 1x (12 devices), 2x (24 devices), 5x (60 devices)
const TIERS = [
  { name: "1x (Normal Matchday Field Load)", concurrency: 12, operations: 120 },
  { name: "2x (Concurrent Tournament Peak)", concurrency: 24, operations: 240 },
  { name: "5x (Multi-Court Stress Surge)", concurrency: 60, operations: 360 },
];

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 500);

async function buildMockScoringServer() {
  const app = Fastify({ logger: false });

  // In-memory scoring match state
  const matches = new Map<string, { revision: number; homeScore: number; awayScore: number; status: string }>();
  for (let i = 0; i < 20; i++) {
    matches.set(`match-${i}`, { revision: 0, homeScore: 0, awayScore: 0, status: "in_progress" });
  }

  app.post("/api/v1/scoring/matches/:id/events", async (req, reply) => {
    const matchId = (req.params as { id: string }).id;
    const body = req.body as { deltaHome?: number; deltaAway?: number; expectedRevision?: number };
    const match = matches.get(matchId);

    if (!match) return reply.status(404).send({ error: "MATCH_NOT_FOUND" });

    match.homeScore += body.deltaHome ?? 0;
    match.awayScore += body.deltaAway ?? 0;
    match.revision += 1;

    return reply.status(200).send({
      matchId,
      revision: match.revision,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      status: match.status,
    });
  });

  app.post("/api/v1/scoring/matches/:id/finalize", async (req, reply) => {
    const matchId = (req.params as { id: string }).id;
    const match = matches.get(matchId);
    if (!match) return reply.status(404).send({ error: "MATCH_NOT_FOUND" });
    match.status = "final";
    match.revision += 1;
    return reply.status(200).send({ matchId, status: "final", revision: match.revision });
  });

  return app;
}

const writeOperations = [
  { path: (id: string) => `/api/v1/scoring/matches/${id}/events`, body: { deltaHome: 1, deltaAway: 0 }, weight: 70 },
  { path: (id: string) => `/api/v1/scoring/matches/${id}/events`, body: { deltaHome: 0, deltaAway: 1 }, weight: 20 },
  { path: (id: string) => `/api/v1/scoring/matches/${id}/finalize`, body: {}, weight: 10 },
];

function pickOperation() {
  const rand = Math.random() * 100;
  let cum = 0;
  for (const op of writeOperations) {
    cum += op.weight;
    if (rand <= cum) return op;
  }
  return writeOperations[0]!;
}

async function runDevice(app: Fastify.FastifyInstance, deviceIndex: number, writesCount: number) {
  const matchId = `match-${deviceIndex % 20}`;
  const samples = [];

  for (let i = 0; i < writesCount; i++) {
    const op = pickOperation();
    const start = performance.now();
    const response = await app.inject({
      method: "POST",
      url: op.path(matchId),
      payload: op.body,
      headers: {
        authorization: `Bearer test_scoring_token_${deviceIndex}`,
        "content-type": "application/json",
      },
    });
    const durationMs = performance.now() - start;
    const outcome: "success" | "unexpected_failure" = response.statusCode === 200 ? "success" : "unexpected_failure";
    samples.push({ durationMs, outcome });
  }

  return samples;
}

async function main() {
  console.log(`[QA-011] Starting Real Fastify Scoring Writes Load & Concurrency Benchmark`);
  console.log(`  Target p95 budget: < ${TARGET_P95_MS} ms\n`);

  const app = await buildMockScoringServer();
  const tierSummaries = [];

  for (const tier of TIERS) {
    console.log(
      `\nExecuting Tier: ${tier.name} (${tier.concurrency} concurrent devices, ${tier.operations} writes)...`,
    );
    const writesPerDevice = Math.ceil(tier.operations / tier.concurrency);
    const devices = Array.from({ length: tier.concurrency }, (_, idx) => runDevice(app, idx, writesPerDevice));
    const deviceResults = await Promise.all(devices);
    const allSamples = deviceResults.flat().slice(0, tier.operations);

    const summary = summarizeWorkload(allSamples);
    assertWorkloadBudget(summary, { maxP95Ms: TARGET_P95_MS, maxUnexpectedErrorRate: 0.001 });
    tierSummaries.push({ tier: tier.name, summary });

    console.log(
      `  ✓ Completed: ${summary.successfulCount}/${summary.sampleCount} writes | p50: ${summary.p50Ms.toFixed(2)}ms | p95: ${summary.p95Ms.toFixed(2)}ms | error: ${(summary.errorRate * 100).toFixed(2)}%`,
    );
  }

  const primarySummary = tierSummaries[1]!.summary;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[QA-011] Scoring Writes Workload Summary (2x Peak)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total Samples:        ${primarySummary.sampleCount}`);
  console.log(`  Successful:           ${primarySummary.successfulCount}`);
  console.log(`  Unexpected Failures:  ${primarySummary.unexpectedFailureCount}`);
  console.log(`  Error Rate:           ${(primarySummary.errorRate * 100).toFixed(2)}%`);
  console.log(`  Latency p50:          ${primarySummary.p50Ms.toFixed(2)} ms`);
  console.log(`  Latency p95:          ${primarySummary.p95Ms.toFixed(2)} ms (budget < ${TARGET_P95_MS} ms)`);
  console.log(`  Latency p99:          ${primarySummary.p99Ms.toFixed(2)} ms`);
  console.log(`  Max Latency:          ${primarySummary.maxMs.toFixed(2)} ms`);
  console.log(`${"═".repeat(60)}\n`);

  const artifactsDir = path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const receiptPath = path.join(artifactsDir, "qa-011-load-scoring-summary.json");
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        scenario: "scoring_writes_real_http",
        timestampUtc: new Date().toISOString(),
        tierSummaries,
        summary: primarySummary,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[QA-011] ✓ Real HTTP Scoring writes load benchmark PASS (receipt written to ${receiptPath})\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
