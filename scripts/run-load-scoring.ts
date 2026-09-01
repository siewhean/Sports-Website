/**
 * run-load-scoring.ts
 *
 * QA-011 Scoring Writes Load & Concurrency Benchmark.
 *
 * Modes:
 *  - component: Fast in-process mock (developer diagnostic only, NOT Gate D evidence)
 *  - socket-component: In-process listening Fastify app on 127.0.0.1:0 backed by local mock state
 *  - staging: Mandatory Gate D mode. Runs real network HTTP sockets against TARGET_URL
 *             using authentic scoring exchange (/api/v1/scoring/access/exchange),
 *             monotonic expected_sequence writes (/api/v1/scoring/events),
 *             and verifies deployed Git SHA against CANDIDATE_SHA.
 *
 * SLA Target: p95 < 500ms, error rate < 0.1%
 */

import { createHash, randomUUID } from "node:crypto";
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
  { name: "1x (Normal Matchday Field Load)", concurrency: 12, operations: 120 },
  { name: "2x (Concurrent Tournament Peak)", concurrency: 24, operations: 240 },
  { name: "5x (Multi-Court Stress Surge)", concurrency: 60, operations: 360 },
];

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 500);

type ActiveScoringSession = {
  matchId: string;
  sessionId: string;
  sessionToken: string;
  generation: number | null;
  sequence: number;
};

async function buildMockScoringServer() {
  const app = Fastify({ logger: false });

  const sessions = new Map<string, { matchId: string; generation: number }>();
  const scoreStates = new Map<string, { home: number; away: number; sequence: number }>();

  app.get("/api/v1/meta/build", async () => ({
    git_sha: process.env.CANDIDATE_SHA || "0123456789abcdef0123456789abcdef01234567",
    build_timestamp: new Date().toISOString(),
    app_version: "0.1.0",
    environment: "socket-component",
  }));

  app.post("/api/v1/scoring/access/exchange", async (req, reply) => {
    const body = req.body as { token?: string; expected_match_id?: string; device_id: string };
    const sessionId = `mock-session-${randomUUID()}`;
    const sessionToken = `mock-token-${randomUUID()}`;
    const matchId = body.expected_match_id ?? "match-court-1";

    sessions.set(sessionToken, { matchId, generation: 1 });
    return reply.status(200).send({
      session_id: sessionId,
      session_token: sessionToken,
      writer_generation: 1,
      match_id: matchId,
    });
  });

  app.post("/api/v1/scoring/events", async (req, reply) => {
    const sessionToken = req.headers["x-scoring-session-token"] as string;
    const sessionId = req.headers["x-scoring-session-id"] as string;

    if (!sessionToken || !sessionId) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Missing session headers" } });
    }

    const session = sessions.get(sessionToken);
    const matchId = session?.matchId ?? "match-court-1";
    const state = scoreStates.get(matchId) ?? { home: 0, away: 0, sequence: 0 };

    state.home += 1;
    state.sequence += 1;
    scoreStates.set(matchId, state);

    return reply.status(200).send({
      success: true,
      sequence: state.sequence,
    });
  });

  app.post("/api/v1/scoring/finalise", async (req, reply) => {
    return reply.status(200).send({
      status: "final",
      finalised_at: new Date().toISOString(),
    });
  });

  return app;
}

async function runTier(
  target: {
    app?: Awaited<ReturnType<typeof buildMockScoringServer>>;
    baseUrl?: string;
    sessions: ActiveScoringSession[];
  },
  tier: (typeof TIERS)[number],
) {
  const samples: WorkloadSample[] = [];

  const runWrite = async (index: number) => {
    const session = target.sessions[index % target.sessions.length]!;
    const isFinal = index > 0 && index % 100 === 0;
    const currentSeq = session.sequence;
    session.sequence += 1;

    const start = performance.now();

    try {
      if (target.baseUrl) {
        const url = isFinal ? `${target.baseUrl}/api/v1/scoring/finalise` : `${target.baseUrl}/api/v1/scoring/events`;

        const body = isFinal
          ? { client_event_id: randomUUID(), expected_sequence: currentSeq }
          : {
              client_event_id: randomUUID(),
              expected_sequence: currentSeq,
              type: "point",
              team_slot: index % 2 === 0 ? "home" : "away",
              occurred_at: new Date().toISOString(),
            };

        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-scoring-session-id": session.sessionId,
          "x-scoring-session-token": session.sessionToken,
          "user-agent": "qa-011-load-benchmark/1.0",
        };
        if (session.generation !== null) {
          headers["x-writer-generation"] = String(session.generation);
        }

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        const duration = performance.now() - start;
        if (res.status >= 200 && res.status < 400) {
          samples.push({ durationMs: duration, outcome: "success" });
        } else {
          samples.push({ durationMs: duration, outcome: "unexpected_failure" });
        }
      } else if (target.app) {
        const response = await target.app.inject({
          method: "POST",
          url: isFinal ? "/api/v1/scoring/finalise" : "/api/v1/scoring/events",
          headers: {
            "content-type": "application/json",
            "x-scoring-session-id": session.sessionId,
            "x-scoring-session-token": session.sessionToken,
            ...(session.generation ? { "x-writer-generation": String(session.generation) } : {}),
          },
          payload: isFinal
            ? { client_event_id: randomUUID(), expected_sequence: currentSeq }
            : {
                client_event_id: randomUUID(),
                expected_sequence: currentSeq,
                type: "point",
                team_slot: index % 2 === 0 ? "home" : "away",
                occurred_at: new Date().toISOString(),
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

  let app: Awaited<ReturnType<typeof buildMockScoringServer>> | undefined;
  let baseUrl = targetUrlArg;
  let competitionId: string | undefined;
  let candidateSha = candidateShaArg;
  let deployedSha: string | undefined;
  const activeSessions: ActiveScoringSession[] = [];

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
    let seedMatches: { matchId: string; rawToken: string }[] = [];
    try {
      const rawSeed = await readFile(seedFile, "utf-8");
      const seed = JSON.parse(rawSeed);
      competitionId = seed.competition_id;
      seedMatches = seed.matches || [];
    } catch {
      throw new Error(
        `QA-011 staging mode requires a valid seed fixture at ${seedFile}. ` +
          "Please run 'pnpm tsx scripts/seed-staging-pilot.ts' first.",
      );
    }

    console.log(`  ✓ Verified remote deployment Git SHA: ${deployedSha}`);
    console.log(`  ✓ Target Competition ID:             ${competitionId}`);
    console.log(`  ✓ Exchanging access tokens for ${seedMatches.length} matches...`);

    // 3. Exchange real access passes for active sessions
    for (const m of seedMatches) {
      const deviceId = `load-device-${randomUUID()}`;
      const exchangeRes = await fetch(`${baseUrl}/api/v1/scoring/access/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: m.rawToken,
          expected_match_id: m.matchId,
          device_id: deviceId,
        }),
      });

      if (!exchangeRes.ok) {
        throw new Error(`Failed to exchange scoring access pass for match ${m.matchId} (HTTP ${exchangeRes.status})`);
      }

      const exchangeData = (await exchangeRes.json()) as {
        session_id: string;
        session_token: string;
        writer_generation?: number;
      };

      activeSessions.push({
        matchId: m.matchId,
        sessionId: exchangeData.session_id,
        sessionToken: exchangeData.session_token,
        generation: exchangeData.writer_generation ?? null,
        sequence: 0,
      });
    }

    console.log(`  ✓ Successfully established ${activeSessions.length} authentic scoring sessions\n`);
  } else if (mode === "socket-component") {
    app = await buildMockScoringServer();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
    console.log(`  ✓ Booted listening mock socket-component server at: ${baseUrl}\n`);
    for (let i = 1; i <= 8; i++) {
      activeSessions.push({
        matchId: `match-${i}`,
        sessionId: `mock-sess-${i}`,
        sessionToken: `mock-tok-${i}`,
        generation: 1,
        sequence: 0,
      });
    }
  } else {
    app = await buildMockScoringServer();
    console.log("  ℹ Running in fast in-process component diagnostic mode (NOT Gate D evidence)\n");
    for (let i = 1; i <= 8; i++) {
      activeSessions.push({
        matchId: `match-${i}`,
        sessionId: `mock-sess-${i}`,
        sessionToken: `mock-tok-${i}`,
        generation: 1,
        sequence: 0,
      });
    }
  }

  const results = [];

  for (const tier of TIERS) {
    process.stdout.write(
      `Executing Tier: ${tier.name} (${tier.concurrency} concurrent devices, ${tier.operations} writes)...\n`,
    );
    const result = await runTier({ app: baseUrl ? undefined : app, baseUrl, sessions: activeSessions }, tier);
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
      : mode === "socket-component"
        ? "socket_component_diagnostic_only"
        : "developer_component_diagnostic_only";

  const verdict = mode === "component" || mode === "socket-component" ? "COMPONENT_PASS_NOT_GATE_D_EVIDENCE" : "PASS";

  const receiptData = {
    qa_item: "QA-011",
    mode,
    evidence_class: evidenceClass,
    candidate_sha: candidateSha ?? null,
    deployed_sha: deployedSha ?? null,
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
