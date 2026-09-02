/**
 * run-load-public.ts
 *
 * QA-010 Public Pages Load & Endurance Workload Benchmark.
 *
 * Modes:
 *  - component: Fast in-process mock (developer diagnostic only, NOT Gate D evidence)
 *  - socket-component: In-process listening Fastify app on 127.0.0.1:0 backed by local mock state
 *  - staging: Mandatory Gate D mode. Runs real network HTTP sockets against TARGET_URL
 *             and verifies deployed Git SHA against CANDIDATE_SHA.
 *
 * SLA Target: p95 < 2,500ms, error rate < 0.1%
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
import { gateCC4PublicHeaders } from "../apps/api/src/gate-c-public-http.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Mode = "component" | "socket-component" | "staging";

function parseMode(): Mode {
  if (process.argv.includes("--mode=staging") || process.env.LOAD_MODE === "staging") return "staging";
  if (
    process.argv.includes("--mode=socket-component") ||
    process.argv.includes("--mode=local-integration") ||
    process.argv.includes("--mode=integration") ||
    process.env.LOAD_MODE === "socket-component"
  ) {
    return "socket-component";
  }
  return "component";
}

const mode = parseMode();

const targetUrlArg = process.argv.find((a) => a.startsWith("--target-url="))?.split("=")[1] ?? process.env.TARGET_URL;

const candidateShaArg =
  process.argv.find((a) => a.startsWith("--candidate-sha="))?.split("=")[1] ?? process.env.CANDIDATE_SHA;

const TIERS = [
  { name: "1x (Normal Pilot Load)", concurrency: 10, operations: 100 },
  { name: "2x (Peak Pilot Traffic)", concurrency: 20, operations: 200 },
  { name: "5x (Stress Load Surge)", concurrency: 50, operations: 300 },
];

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 2500);

async function buildPublicServer() {
  const app = Fastify({ logger: false });

  app.get("/api/v1/meta/build", async () => ({
    git_sha: process.env.CANDIDATE_SHA || "0123456789abcdef0123456789abcdef01234567",
    build_timestamp: new Date().toISOString(),
    app_version: "0.1.0",
    environment: "socket-component",
  }));

  const freshnessMock = {
    division_id: "div-vball-01",
    division_projection_versions: { "div-vball-01": 1 },
    schedule_version: 1,
    result_version: 1,
    projection_version: 1,
    generated_at: new Date().toISOString(),
    source_updated_at: new Date(Date.now() - 10000).toISOString(),
    etag: "projection-1",
  };

  app.get("/api/v1/public/competitions", async (_req, reply) => {
    return reply.status(200).send({
      competitions: [
        { id: "comp-01", name: "National Volleyball Championship 2026", sport: "volleyball", status: "published" },
        { id: "comp-02", name: "Spring Badminton Open 2026", sport: "badminton", status: "published" },
      ],
    });
  });

  app.get("/api/v1/public/competitions/:id", async (req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      id: (req.params as { id: string }).id,
      name: "National Volleyball Championship 2026",
      divisions: [
        { id: "div-vball-01", name: "Men Open" },
        { id: "div-vball-02", name: "Women Open" },
      ],
    });
  });

  app.get("/api/v1/public/competitions/:id/schedule", async (_req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-vball-01",
      matches: Array.from({ length: 16 }, (_, i) => ({
        matchId: `m-${i}`,
        court: `Court ${(i % 4) + 1}`,
        startTime: "2026-09-01T09:00:00.000Z",
        homeEntry: `Team ${i * 2 + 1}`,
        awayEntry: `Team ${i * 2 + 2}`,
      })),
    });
  });

  app.get("/api/v1/public/competitions/:id/standings", async (_req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-vball-01",
      standings: [
        { rank: 1, team: "Team Alpha", played: 3, won: 3, drawn: 0, lost: 0, points: 9 },
        { rank: 2, team: "Team Beta", played: 3, won: 2, drawn: 0, lost: 1, points: 6 },
      ],
    });
  });

  app.get("/api/v1/public/competitions/:id/brackets", async (_req, reply) => {
    const headers = gateCC4PublicHeaders(freshnessMock);
    reply.headers(headers);
    return reply.status(200).send({
      divisionId: "div-vball-01",
      bracket: { nodes: [{ matchId: "m-gf1", round: "Grand Final", status: "ready" }] },
    });
  });

  app.get("/api/v1/public/search", async (req, reply) => {
    const q = (req.query as { q?: string }).q ?? "";
    return reply.status(200).send({
      results: [{ id: "comp-01", name: `Result for ${q}` }],
    });
  });

  return app;
}

async function runTier(
  target: {
    app?: Awaited<ReturnType<typeof buildPublicServer>>;
    baseUrl?: string;
    competitionId?: string;
    publicCompetitionSlug?: string;
  },
  tier: (typeof TIERS)[number],
) {
  const compId = target.competitionId ?? "comp-01";
  const routes = target.publicCompetitionSlug
    ? [
        {
          method: "GET" as const,
          path: `/api/v1/public/competitions/${encodeURIComponent(target.publicCompetitionSlug)}/current`,
        },
      ]
    : [
        { method: "GET" as const, path: "/api/v1/public/competitions" },
        { method: "GET" as const, path: `/api/v1/public/competitions/${compId}` },
        { method: "GET" as const, path: `/api/v1/public/competitions/${compId}/schedule` },
        { method: "GET" as const, path: `/api/v1/public/competitions/${compId}/standings` },
        { method: "GET" as const, path: `/api/v1/public/competitions/${compId}/brackets` },
        { method: "GET" as const, path: "/api/v1/public/search?q=volleyball" },
      ];

  const samples: WorkloadSample[] = [];

  const runOperation = async (index: number) => {
    const route = routes[index % routes.length]!;
    const start = performance.now();
    try {
      if (target.baseUrl) {
        const res = await fetch(`${target.baseUrl}${route.path}`, {
          method: route.method,
          headers: { "user-agent": "qa-010-load-benchmark/1.0" },
        });
        const duration = performance.now() - start;
        if (res.status >= 200 && res.status < 400) {
          samples.push({ durationMs: duration, outcome: "success" });
        } else {
          samples.push({ durationMs: duration, outcome: "unexpected_failure" });
        }
      } else if (target.app) {
        const response = await target.app.inject({
          method: route.method,
          url: route.path,
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
        await runOperation(op);
      }
    }
  });

  await Promise.all(workers);

  const summary = summarizeWorkload(samples);
  return { tier: tier.name, summary, samples };
}

async function main() {
  console.log(`[QA-010] Starting Fastify Public Pages Load Workload Benchmark (Mode: ${mode.toUpperCase()})`);
  console.log(`  Target p95 budget: < ${TARGET_P95_MS} ms\n`);

  let app: Awaited<ReturnType<typeof buildPublicServer>> | undefined;
  let baseUrl = targetUrlArg;
  let competitionId: string | undefined;
  let publicCompetitionSlug: string | undefined;
  const candidateSha = candidateShaArg;
  let deployedSha: string | undefined;

  if (mode === "staging") {
    if (!baseUrl) {
      throw new Error(
        "QA-010 staging mode requires TARGET_URL (e.g. https://matchday-gate-d-api.onrender.com). " +
          "Mock in-process execution is prohibited for Gate D evidence.",
      );
    }
    if (!candidateSha || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
      throw new Error(
        "QA-010 staging mode requires a valid 40-character CANDIDATE_SHA. " + `Received: "${candidateSha}"`,
      );
    }

    // 1. Verify Deployment Provenance
    try {
      const metaRes = await fetch(`${baseUrl}/api/v1/meta/build`);
      if (!metaRes.ok) throw new Error(`Status ${metaRes.status}`);
      const meta = (await metaRes.json()) as { git_sha?: string };
      deployedSha = meta.git_sha;
    } catch (err) {
      throw new Error(`Failed to retrieve deployment build metadata from ${baseUrl}/api/v1/meta/build: ${err}`);
    }

    if (!deployedSha || deployedSha.toLowerCase() !== candidateSha.toLowerCase()) {
      throw new Error(
        `Deployment SHA mismatch: Server is serving SHA "${deployedSha}", but test expected CANDIDATE_SHA "${candidateSha}". ` +
          "Please deploy the candidate commit to staging before running Gate D qualification.",
      );
    }

    // 2. Read Seed Fixture
    const seedFile = path.join(root, "artifacts/staging-pilot-seed.json");
    try {
      const rawSeed = await readFile(seedFile, "utf-8");
      const seed = JSON.parse(rawSeed);
      competitionId = seed.competition_id;
      publicCompetitionSlug = seed.competition_slug;
      if (
        typeof competitionId !== "string" ||
        typeof publicCompetitionSlug !== "string" ||
        publicCompetitionSlug.length < 1
      ) {
        throw new Error("Seed fixture is missing competition_id or competition_slug");
      }
    } catch {
      throw new Error(
        `QA-010 staging mode requires a valid seed fixture at ${seedFile}. ` +
          "Please run 'pnpm tsx scripts/seed-staging-pilot.ts' first.",
      );
    }

    console.log(`  ✓ Verified remote deployment Git SHA: ${deployedSha}`);
    console.log(`  ✓ Target Competition ID:             ${competitionId}`);
    console.log(`  ✓ Target Competition Slug:           ${publicCompetitionSlug}\n`);
  } else if (mode === "socket-component") {
    app = await buildPublicServer();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
    console.log(`  ✓ Booted listening mock socket-component server at: ${baseUrl}\n`);
  } else {
    app = await buildPublicServer();
    console.log("  ℹ Running in fast in-process component diagnostic mode (NOT Gate D evidence)\n");
  }

  const results = [];

  for (const tier of TIERS) {
    process.stdout.write(
      `Executing Tier: ${tier.name} (${tier.concurrency} concurrent clients, ${tier.operations} ops)...\n`,
    );
    const result = await runTier(
      { app: baseUrl ? undefined : app, baseUrl, competitionId, publicCompetitionSlug },
      tier,
    );
    results.push(result);
    console.log(
      `  ✓ Completed: ${result.summary.sampleCount}/${tier.operations} ops | ` +
        `p50: ${result.summary.p50Ms.toFixed(2)}ms | ` +
        `p95: ${result.summary.p95Ms.toFixed(2)}ms | ` +
        `error: ${(result.summary.errorRate * 100).toFixed(2)}%\n`,
    );
  }

  const peakResult = results.find((r) => r.tier.includes("2x")) ?? results[0]!;
  console.log("═".repeat(60));
  console.log(`[QA-010] Public Pages Workload Summary (2x Peak) [${mode.toUpperCase()}]`);
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
  const summaryPath = path.join(artifactDir, "qa-010-load-public-summary.json");

  const evidenceClass =
    mode === "staging"
      ? "gate_d_staging"
      : mode === "socket-component"
        ? "socket_component_diagnostic_only"
        : "developer_component_diagnostic_only";

  const verdict = mode === "component" || mode === "socket-component" ? "COMPONENT_PASS_NOT_GATE_D_EVIDENCE" : "PASS";

  const receiptData = {
    qa_item: "QA-010",
    mode,
    evidence_class: evidenceClass,
    candidate_sha: candidateSha ?? null,
    deployed_sha: deployedSha ?? null,
    competition_id: competitionId ?? null,
    competition_slug: publicCompetitionSlug ?? null,
    target_url: baseUrl ?? null,
    title: "Public Pages Read Workload Summary",
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

  console.log(`[QA-010] ✓ ${mode.toUpperCase()} public pages load benchmark PASS (${summaryPath})\n`);
  if (app) await app.close();
}

main().catch((err) => {
  console.error("[QA-010] ❌ Load benchmark failed:", err);
  process.exit(1);
});
