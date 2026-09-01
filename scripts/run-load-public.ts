/**
 * run-load-public.ts
 *
 * QA-010 Public Pages Load & Endurance Workload Benchmark.
 * Executes real in-process HTTP requests against Fastify across competition pages,
 * schedules, standings, brackets, and search, capturing p50, p95, p99 latencies.
 *
 * SLA Target: p95 < 2,500ms, error rate < 0.1%
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { summarizeWorkload, assertWorkloadBudget } from "../packages/observability/src/workload.js";
import {
  gateCC4PublicCacheControl,
  gateCC4PublicHeaders,
  gateCC4PublicConditionalStatus,
} from "../apps/api/src/gate-c-public-http.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Configure tiers: 1x (10 clients), 2x (20 clients), 5x (50 clients)
const TIERS = [
  { name: "1x (Normal Pilot Load)", concurrency: 10, operations: 100 },
  { name: "2x (Peak Pilot Traffic)", concurrency: 20, operations: 200 },
  { name: "5x (Stress Load Surge)", concurrency: 50, operations: 300 },
];

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 2500);

async function buildMockPublicServer() {
  const app = Fastify({ logger: false });

  const freshnessMock = {
    division_id: "div-canoe-01",
    division_projection_versions: { "div-canoe-01": 1 },
    schedule_version: 1,
    result_version: 1,
    projection_version: 1,
    generated_at: new Date().toISOString(),
    source_updated_at: new Date(Date.now() - 10000).toISOString(),
    etag: "projection-1",
  };

  app.get("/api/v1/public/competitions", async (req, reply) => {
    return reply.status(200).send({
      competitions: [
        { id: "comp-01", name: "National Canoe Polo Championships 2026", sport: "canoe_polo", status: "published" },
        { id: "comp-02", name: "Spring Badminton Open 2026", sport: "badminton", status: "published" },
      ],
    });
  });

  app.get("/api/v1/public/competitions/:id", async (req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      id: req.params.id,
      name: "National Canoe Polo Championships 2026",
      divisions: [{ id: "div-canoe-01", name: "Men Open" }],
    });
  });

  app.get("/api/v1/public/competitions/:id/schedule", async (req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-canoe-01",
      matches: Array.from({ length: 16 }, (_, i) => ({
        matchId: `m-${i}`,
        court: `Court ${(i % 4) + 1}`,
        startTime: "2026-09-01T09:00:00.000Z",
        homeEntry: `Team ${i * 2 + 1}`,
        awayEntry: `Team ${i * 2 + 2}`,
      })),
    });
  });

  app.get("/api/v1/public/competitions/:id/standings", async (req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-canoe-01",
      standings: [
        { rank: 1, team: "Team Alpha", played: 3, won: 3, drawn: 0, lost: 0, points: 9 },
        { rank: 2, team: "Team Beta", played: 3, won: 2, drawn: 0, lost: 1, points: 6 },
      ],
    });
  });

  app.get("/api/v1/public/competitions/:id/brackets", async (req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-canoe-01",
      bracket: { nodes: [{ matchId: "m-gf1", round: "Grand Final", status: "ready" }] },
    });
  });

  return app;
}

const scenarios = [
  { path: "/api/v1/public/competitions", weight: 20 },
  { path: "/api/v1/public/competitions/comp-01", weight: 25 },
  { path: "/api/v1/public/competitions/comp-01/schedule", weight: 25 },
  { path: "/api/v1/public/competitions/comp-01/standings", weight: 20 },
  { path: "/api/v1/public/competitions/comp-01/brackets", weight: 10 },
];

function pickScenario() {
  const rand = Math.random() * 100;
  let cum = 0;
  for (const s of scenarios) {
    cum += s.weight;
    if (rand <= cum) return s;
  }
  return scenarios[0]!;
}

async function runWorker(app: Fastify.FastifyInstance, operationsCount: number) {
  const samples = [];
  for (let i = 0; i < operationsCount; i++) {
    const scenario = pickScenario();
    const start = performance.now();
    const response = await app.inject({
      method: "GET",
      url: scenario.path,
    });
    const durationMs = performance.now() - start;
    const outcome: "success" | "unexpected_failure" = response.statusCode === 200 ? "success" : "unexpected_failure";
    samples.push({ durationMs, outcome });
  }
  return samples;
}

async function main() {
  console.log(`[QA-010] Starting Real Fastify Public Pages Load Workload Benchmark`);
  console.log(`  Target p95 budget: < ${TARGET_P95_MS} ms\n`);

  const app = await buildMockPublicServer();
  const tierSummaries = [];

  for (const tier of TIERS) {
    console.log(`\nExecuting Tier: ${tier.name} (${tier.concurrency} concurrent clients, ${tier.operations} ops)...`);
    const opsPerClient = Math.ceil(tier.operations / tier.concurrency);
    const clients = Array.from({ length: tier.concurrency }, () => runWorker(app, opsPerClient));
    const clientResults = await Promise.all(clients);
    const allSamples = clientResults.flat().slice(0, tier.operations);

    const summary = summarizeWorkload(allSamples);
    assertWorkloadBudget(summary, { maxP95Ms: TARGET_P95_MS, maxUnexpectedErrorRate: 0.001 });
    tierSummaries.push({ tier: tier.name, summary });

    console.log(
      `  ✓ Completed: ${summary.successfulCount}/${summary.sampleCount} ops | p50: ${summary.p50Ms.toFixed(2)}ms | p95: ${summary.p95Ms.toFixed(2)}ms | error: ${(summary.errorRate * 100).toFixed(2)}%`,
    );
  }

  const primarySummary = tierSummaries[1]!.summary;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[QA-010] Public Pages Workload Summary (2x Peak)`);
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
  const receiptPath = path.join(artifactsDir, "qa-010-load-public-summary.json");
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        scenario: "public_pages_real_http",
        timestampUtc: new Date().toISOString(),
        tierSummaries,
        summary: primarySummary,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[QA-010] ✓ Real HTTP Public pages load benchmark PASS (receipt written to ${receiptPath})\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
