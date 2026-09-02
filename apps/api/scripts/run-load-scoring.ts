/**
 * QA-011 scoring writes load benchmark.
 *
 * Gate D evidence is produced only in staging mode. Staging mode always uses
 * the deployed Matchday HTTP API, authentic access exchange/session headers,
 * exact deployed-SHA attestation, and exactly one sequential writer per match.
 *
 * The measured Volleyball workload deliberately alternates a canonical point
 * with a reversal of that exact event. This keeps the aggregate score bounded
 * while still exercising real mutation, reducer, persistence, fencing and
 * projection work for arbitrarily long endurance runs. Finalisation belongs to
 * QA-006 and is intentionally not mixed into this latency benchmark.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  assertWorkloadBudget,
  summarizeWorkload,
  type WorkloadSample,
} from "../../../packages/observability/src/workload.js";
import { requireWriterAccessExchange, type AccessExchange } from "./lib/qa011-access-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Mode = "component" | "socket-component" | "staging";
type ActiveScoringSession = {
  matchId: string;
  sessionId: string;
  sessionToken: string;
  generation: number;
  sequence: number;
  pendingReversalEventId: string | null;
};

type Target = {
  app?: Awaited<ReturnType<typeof buildMockScoringServer>>;
  baseUrl?: string;
  sessions: ActiveScoringSession[];
};

const TIERS = [
  { name: "1x (Normal Matchday Field Load)", operations: 120 },
  { name: "2x (Concurrent Tournament Peak)", operations: 240 },
  { name: "5x (Multi-Court Stress Surge)", operations: 360 },
] as const;

const TARGET_P95_MS = Number(process.env.TARGET_P95_MS ?? 500);
const RESULT_PROPAGATION_P95_MS = Number(process.env.RESULT_PROPAGATION_P95_MS ?? 2000);
const CURRENT_SLO_DEFINITION_VERSION = "2026.09.gate-d";
const MINIMUM_SAMPLES_THRESHOLD = Number(process.env.GATE_D_MINIMUM_SAMPLES ?? 10);
const MINIMUM_SESSIONS_THRESHOLD = Number(process.env.GATE_D_MINIMUM_SESSIONS ?? 1);

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
const targetUrlArg =
  process.argv.find((value) => value.startsWith("--target-url="))?.split("=")[1] ?? process.env.TARGET_URL;
const candidateShaArg =
  process.argv.find((value) => value.startsWith("--candidate-sha="))?.split("=")[1] ?? process.env.CANDIDATE_SHA;

function validatedSeedHandoffDirectory(secretFile: string): string {
  const resolvedFile = path.resolve(secretFile);
  const expectedDirectoryPrefix = path.resolve(tmpdir(), "matchday-gate-d-scoring-");
  const parent = path.dirname(resolvedFile);
  if (
    path.basename(resolvedFile) !== "scorekeeper-access.json" ||
    !parent.startsWith(expectedDirectoryPrefix) ||
    parent === expectedDirectoryPrefix
  ) {
    throw new Error("GATE_D_SCORING_SECRET_FILE must be the single-use seed:staging:pilot handoff file");
  }
  return parent;
}

function scoringHeaders(session: ActiveScoringSession): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-scoring-session-id": session.sessionId,
    "x-scoring-session-token": session.sessionToken,
    "x-writer-generation": String(session.generation),
  };
}

async function buildMockScoringServer() {
  const app = Fastify({ logger: false });
  const sessions = new Map<string, { matchId: string; generation: number }>();
  const sequences = new Map<string, number>();

  app.get("/api/v1/meta/build", async () => ({
    git_sha: process.env.CANDIDATE_SHA || "0123456789abcdef0123456789abcdef01234567",
    build_timestamp: new Date().toISOString(),
    app_version: "0.1.0",
    environment: "socket-component",
  }));

  app.post("/api/v1/scoring/access/exchange", async (request, reply) => {
    const body = request.body as { expected_match_id?: string };
    const matchId = body.expected_match_id ?? `match-${randomUUID()}`;
    const sessionId = randomUUID();
    const sessionToken = `${randomUUID()}${randomUUID()}`;
    sessions.set(sessionToken, { matchId, generation: 1 });
    sequences.set(matchId, 0);
    return reply.status(200).send({
      session_id: sessionId,
      session_token: sessionToken,
      match_id: matchId,
      mode: "writer",
      generation: 1,
    });
  });

  app.get("/api/v1/scoring/session", async (request, reply) => {
    const token = request.headers["x-scoring-session-token"] as string | undefined;
    const session = token ? sessions.get(token) : undefined;
    if (!session) return reply.status(401).send({ error: { code: "UNAUTHORIZED" } });
    return reply.status(200).send({
      match: { id: session.matchId, state: "ready" },
      writer: { generation: session.generation, read_only: false },
      through_sequence: sequences.get(session.matchId) ?? 0,
    });
  });

  app.post("/api/v1/scoring/events", async (request, reply) => {
    const token = request.headers["x-scoring-session-token"] as string | undefined;
    const session = token ? sessions.get(token) : undefined;
    if (!session) return reply.status(401).send({ error: { code: "UNAUTHORIZED" } });
    const body = request.body as { expected_sequence?: number };
    const current = sequences.get(session.matchId) ?? 0;
    if (body.expected_sequence !== current) {
      return reply.status(409).send({ error: { code: "SEQUENCE_CONFLICT" } });
    }
    const eventId = randomUUID();
    sequences.set(session.matchId, current + 1);
    return reply.status(200).send({ event_id: eventId, sequence: current + 1, duplicate: false });
  });

  return app;
}

async function requestJson(
  target: Target,
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (target.baseUrl) {
    const response = await fetch(`${target.baseUrl}${url}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      // Error handling below is status based; JSON is best effort.
    }
    return { status: response.status, data };
  }

  if (!target.app) throw new Error("Scoring workload target is not configured");
  const response =
    body === undefined
      ? await target.app.inject({ method, url, headers })
      : await target.app.inject({ method, url, headers, payload: JSON.stringify(body) });
  let data: Record<string, unknown> = {};
  try {
    data = response.json() as Record<string, unknown>;
  } catch {
    // Same best-effort behavior as network mode.
  }
  return { status: response.statusCode, data };
}

function operationsForStream(totalOperations: number, streamIndex: number, streamCount: number): number {
  const base = Math.floor(totalOperations / streamCount);
  return base + (streamIndex < totalOperations % streamCount ? 1 : 0);
}

async function appendMeasuredMutation(
  target: Target,
  session: ActiveScoringSession,
  step: number,
): Promise<WorkloadSample> {
  const started = performance.now();
  const startingMatch = session.sequence === 0;
  const reversing = !startingMatch && session.pendingReversalEventId !== null;
  const body = startingMatch
    ? {
        client_event_id: randomUUID(),
        expected_sequence: session.sequence,
        type: "match_started",
        occurred_at: new Date().toISOString(),
      }
    : reversing
      ? {
          client_event_id: randomUUID(),
          expected_sequence: session.sequence,
          type: "reversal",
          reversal_target_event_id: session.pendingReversalEventId,
          reason: "QA-011 bounded endurance reversal",
          occurred_at: new Date().toISOString(),
        }
      : {
          client_event_id: randomUUID(),
          expected_sequence: session.sequence,
          type: "point",
          team_slot: step % 2 === 0 ? "home" : "away",
          segment_number: 1,
          occurred_at: new Date().toISOString(),
        };

  try {
    const response = await requestJson(target, "POST", "/api/v1/scoring/events", scoringHeaders(session), body);
    const durationMs = performance.now() - started;
    if (response.status < 200 || response.status >= 300) {
      return { durationMs, outcome: "unexpected_failure" };
    }

    session.sequence += 1;
    if (startingMatch) {
      session.pendingReversalEventId = null;
    } else if (reversing) {
      session.pendingReversalEventId = null;
    } else {
      const eventId = response.data.event_id;
      if (typeof eventId !== "string" || !eventId) {
        return { durationMs, outcome: "unexpected_failure" };
      }
      session.pendingReversalEventId = eventId;
    }
    return { durationMs, outcome: "success" };
  } catch {
    return { durationMs: performance.now() - started, outcome: "unexpected_failure" };
  }
}

async function runTier(target: Target, tier: (typeof TIERS)[number]) {
  if (target.sessions.length === 0) throw new Error("QA-011 requires at least one independent scoring session");
  const samples: WorkloadSample[] = [];

  // One async worker == one match/session. Streams run in parallel, while an
  // authoritative match never has two load-runner writers racing sequence/fence.
  const streams = target.sessions.map(async (session, streamIndex) => {
    const count = operationsForStream(tier.operations, streamIndex, target.sessions.length);
    for (let step = 0; step < count; step++) {
      const sample = await appendMeasuredMutation(target, session, step);
      samples.push(sample);
      if (sample.outcome !== "success") break;
    }
  });

  await Promise.all(streams);
  const summary = summarizeWorkload(samples);
  return {
    tier: tier.name,
    requestedOperations: tier.operations,
    independentStreams: target.sessions.length,
    summary,
  };
}

async function recoverSessionState(target: Target, session: ActiveScoringSession) {
  const response = await requestJson(target, "GET", "/api/v1/scoring/session", scoringHeaders(session));
  if (response.status !== 200) {
    throw new Error(`Failed to recover scoring session state for match ${session.matchId} (HTTP ${response.status})`);
  }
  const throughSequence = response.data.through_sequence;
  if (!Number.isInteger(throughSequence) || Number(throughSequence) < 0) {
    throw new Error(`Scoring session ${session.sessionId} returned an invalid through_sequence`);
  }
  session.sequence = Number(throughSequence);
  // Staging fixtures are required to be unscored before QA-011. Recovering a
  // non-zero stream is allowed only when the same runner has continued it; the
  // seed validation must keep initial scoring state clean.
  session.pendingReversalEventId = null;
}

async function closeOpenReversals(target: Target): Promise<void> {
  for (const session of target.sessions) {
    if (!session.pendingReversalEventId) continue;
    const response = await requestJson(target, "POST", "/api/v1/scoring/events", scoringHeaders(session), {
      client_event_id: randomUUID(),
      expected_sequence: session.sequence,
      type: "reversal",
      reversal_target_event_id: session.pendingReversalEventId,
      reason: "QA-011 end-of-run bounded-state cleanup",
      occurred_at: new Date().toISOString(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to close bounded score state for match ${session.matchId} (HTTP ${response.status})`);
    }
    session.sequence += 1;
    session.pendingReversalEventId = null;
  }
}

async function measureResultPropagation(
  target: Target,
  competitionSlug: string | undefined,
  sessions: readonly ActiveScoringSession[],
): Promise<ReturnType<typeof summarizeWorkload>> {
  if (!target.baseUrl || !competitionSlug) {
    throw new Error("QA-011 staging result propagation requires the seeded public competition slug");
  }
  const samples: WorkloadSample[] = [];
  for (const session of sessions) {
    const acceptedAt = performance.now();
    try {
      const finalise = await requestJson(target, "POST", "/api/v1/scoring/finalise", scoringHeaders(session), {
        client_event_id: randomUUID(),
        expected_sequence: session.sequence,
        occurred_at: new Date().toISOString(),
      });
      const resultVersion = finalise.data.result_version;
      if (
        finalise.status !== 200 ||
        finalise.data.match_id !== session.matchId ||
        finalise.data.outcome !== "accepted" ||
        !Number.isSafeInteger(resultVersion) ||
        Number(resultVersion) < 1
      ) {
        samples.push({ durationMs: performance.now() - acceptedAt, outcome: "unexpected_failure" });
        continue;
      }
      session.sequence = Number(finalise.data.aggregate_version);
      const deadline = performance.now() + RESULT_PROPAGATION_P95_MS;
      let visible = false;
      while (performance.now() <= deadline) {
        const response = await fetch(
          `${target.baseUrl}/api/v1/public/competitions/${encodeURIComponent(competitionSlug)}/current`,
          { headers: { "user-agent": "qa-011-result-propagation/1.0" } },
        );
        const body = response.ok
          ? ((await response.json()) as { publication?: { result_version?: unknown } })
          : undefined;
        const publicResultVersion = body?.publication?.result_version;
        if (
          response.ok &&
          Number.isSafeInteger(publicResultVersion) &&
          Number(publicResultVersion) >= Number(resultVersion)
        ) {
          visible = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      samples.push({ durationMs: performance.now() - acceptedAt, outcome: visible ? "success" : "unexpected_failure" });
    } catch {
      samples.push({ durationMs: performance.now() - acceptedAt, outcome: "unexpected_failure" });
    }
  }
  return summarizeWorkload(samples);
}

function observationWindow(startedAt: Date, endedAt: Date) {
  if (startedAt >= endedAt) throw new Error("QA-011 observation window must be increasing");
  return { starts_at: startedAt.toISOString(), ends_at: endedAt.toISOString() };
}

async function main() {
  const startedAt = new Date();
  console.log(`[QA-011] Starting scoring writes benchmark (${mode})`);
  let app: Awaited<ReturnType<typeof buildMockScoringServer>> | undefined;
  let baseUrl = targetUrlArg?.replace(/\/$/, "");
  let competitionId: string | undefined;
  let competitionSlug: string | undefined;
  const candidateSha = candidateShaArg;
  let deployedSha: string | undefined;
  const activeSessions: ActiveScoringSession[] = [];

  if (mode === "staging") {
    if (!baseUrl) throw new Error("QA-011 staging mode requires TARGET_URL; in-process fallback is prohibited");
    if (!candidateSha || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
      throw new Error(`QA-011 staging mode requires a strict 40-character CANDIDATE_SHA; received ${candidateSha}`);
    }

    const metaResponse = await fetch(`${baseUrl}/api/v1/meta/build`);
    if (!metaResponse.ok) throw new Error(`Unable to attest deployed build SHA (HTTP ${metaResponse.status})`);
    const meta = (await metaResponse.json()) as { git_sha?: string };
    deployedSha = meta.git_sha;
    if (!deployedSha || deployedSha.toLowerCase() !== candidateSha.toLowerCase()) {
      throw new Error(`Deployment SHA mismatch: deployed=${deployedSha} expected=${candidateSha}`);
    }

    const seedPath = path.join(root, "artifacts/staging-pilot-seed.json");
    const seed = JSON.parse(await readFile(seedPath, "utf8")) as {
      target_url?: string;
      competition_id?: string;
      competition_slug?: string;
      scoreable_matches?: Array<{ match_id: string }>;
    };
    if (!seed.competition_id || !Array.isArray(seed.scoreable_matches) || seed.scoreable_matches.length === 0) {
      throw new Error("Staging seed artifact is missing competition_id or scoreable matches");
    }
    if (seed.target_url && seed.target_url.replace(/\/$/, "") !== baseUrl) {
      throw new Error(`Seed TARGET_URL mismatch: seed=${seed.target_url} runner=${baseUrl}`);
    }
    competitionId = seed.competition_id;
    competitionSlug = seed.competition_slug;
    if (!competitionSlug) throw new Error("Staging seed artifact is missing competition_slug for result propagation");
    const secretFile = process.env.GATE_D_SCORING_SECRET_FILE;
    if (!secretFile) {
      throw new Error("QA-011 staging mode requires the single-use GATE_D_SCORING_SECRET_FILE from seed:staging:pilot");
    }
    const secretDirectory = validatedSeedHandoffDirectory(secretFile);
    let secret: {
      target_url?: string;
      competition_id?: string;
      matches?: Array<{ matchId: string; rawToken: string }>;
    };
    try {
      secret = JSON.parse(await readFile(secretFile, "utf8")) as typeof secret;
    } finally {
      await rm(secretFile, { force: true }).catch(() => undefined);
      await rmdir(secretDirectory).catch((error: unknown) => {
        throw new Error("QA-011 could not remove the single-use scoring handoff directory", { cause: error });
      });
    }
    if (
      secret.target_url?.replace(/\/$/, "") !== baseUrl ||
      secret.competition_id !== competitionId ||
      !Array.isArray(secret.matches) ||
      secret.matches.length !== seed.scoreable_matches.length ||
      secret.matches.some((match) => !seed.scoreable_matches!.some((seedMatch) => seedMatch.match_id === match.matchId))
    ) {
      throw new Error("Single-use scoring handoff does not match the sanitized seed artifact");
    }

    for (const match of secret.matches) {
      if (!match.matchId || !match.rawToken) throw new Error("Seed match is missing matchId/rawToken");
      const exchange = await fetch(`${baseUrl}/api/v1/scoring/access/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: match.rawToken,
          expected_match_id: match.matchId,
          device_id: `qa011-${randomUUID()}`,
          device_label: "QA-011 load stream",
        }),
      });
      if (!exchange.ok) {
        throw new Error(`Access exchange failed for ${match.matchId} (HTTP ${exchange.status})`);
      }
      const data = (await exchange.json()) as AccessExchange;
      const writer = requireWriterAccessExchange(data, match.matchId);
      activeSessions.push({
        matchId: match.matchId,
        sessionId: writer.sessionId,
        sessionToken: writer.sessionToken,
        generation: writer.generation,
        sequence: 0,
        pendingReversalEventId: null,
      });
    }
  } else {
    app = await buildMockScoringServer();
    if (mode === "socket-component") baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    for (let index = 0; index < 8; index++) {
      let status: number;
      let data: AccessExchange;
      if (mode === "component") {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/scoring/access/exchange",
          payload: { expected_match_id: `mock-match-${index}`, device_id: `mock-${index}` },
        });
        status = response.statusCode;
        data = response.json() as typeof data;
      } else {
        const response = await fetch(`${baseUrl}/api/v1/scoring/access/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_match_id: `mock-match-${index}`, device_id: `mock-${index}` }),
        });
        status = response.status;
        data = (await response.json()) as typeof data;
      }
      if (status !== 200) throw new Error("Mock access exchange failed");
      const writer = requireWriterAccessExchange(data, `mock-match-${index}`);
      activeSessions.push({
        matchId: `mock-match-${index}`,
        sessionId: writer.sessionId,
        sessionToken: writer.sessionToken,
        generation: writer.generation,
        sequence: 0,
        pendingReversalEventId: null,
      });
    }
  }

  let target: Target;
  if (baseUrl) {
    target = { baseUrl, sessions: activeSessions };
  } else {
    if (!app) throw new Error("QA-011 component target did not initialise");
    target = { app, sessions: activeSessions };
  }
  for (const session of activeSessions) await recoverSessionState(target, session);

  const results = [];
  let peakResult: Awaited<ReturnType<typeof runTier>> | undefined;
  let propagationSummary: ReturnType<typeof summarizeWorkload> | undefined;
  try {
    for (const tier of TIERS) {
      console.log(
        `  ${tier.name}: ${tier.operations} writes across ${activeSessions.length} independent match streams`,
      );
      const result = await runTier(target, tier);
      results.push(result);
      console.log(
        `    samples=${result.summary.sampleCount} p95=${result.summary.p95Ms.toFixed(2)}ms error=${(
          result.summary.errorRate * 100
        ).toFixed(2)}%`,
      );
    }
    peakResult = results.find((result) => result.tier.includes("2x")) ?? results[0]!;
    assertWorkloadBudget(peakResult.summary, {
      maxP95Ms: TARGET_P95_MS,
      maxUnexpectedErrorRate: 0.001,
    });
    if (mode === "staging") {
      await closeOpenReversals(target);
      const requiredSessions = Math.max(MINIMUM_SAMPLES_THRESHOLD, 10);
      if (activeSessions.length < requiredSessions) {
        throw new Error(`QA-011 result propagation requires ${requiredSessions} independent active scoring sessions`);
      }
      propagationSummary = await measureResultPropagation(
        target,
        competitionSlug,
        activeSessions.slice(0, requiredSessions),
      );
      assertWorkloadBudget(propagationSummary, {
        maxP95Ms: RESULT_PROPAGATION_P95_MS,
        maxUnexpectedErrorRate: 0.001,
      });
    }
  } finally {
    // Restore fixture state even if a budget failure aborts receipt creation.
    await closeOpenReversals(target);
  }

  const artifactDir = path.join(root, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const summaryPath = path.join(artifactDir, "qa-011-load-scoring-summary.json");
  const evidenceClass =
    mode === "staging"
      ? "gate_d_staging"
      : mode === "socket-component"
        ? "socket_component_diagnostic_only"
        : "developer_component_diagnostic_only";
  const verdict = mode === "staging" ? "PASS" : "COMPONENT_PASS_NOT_GATE_D_EVIDENCE";

  const receiptData = {
    qa_item: "QA-011",
    mode,
    evidence_class: evidenceClass,
    slo_definition_version: CURRENT_SLO_DEFINITION_VERSION,
    candidate_sha: candidateSha ?? null,
    deployed_sha: deployedSha ?? null,
    competition_id: competitionId ?? null,
    target_url: baseUrl ?? null,
    title: "Scoring Mutation Writes Workload Summary",
    workload_profile: "volleyball_bounded_point_reversal",
    target_p95_budget_ms: TARGET_P95_MS,
    minimum_samples_threshold: MINIMUM_SAMPLES_THRESHOLD,
    minimum_sessions_threshold: MINIMUM_SESSIONS_THRESHOLD,
    observed_session_count: mode === "staging" ? activeSessions.length : 0,
    observation_window: observationWindow(startedAt, new Date()),
    independent_scoring_streams: activeSessions.length,
    tiers: results.map((result) => ({
      tier: result.tier,
      requested_operations: result.requestedOperations,
      independent_streams: result.independentStreams,
      metrics: result.summary,
    })),
    peak_summary: peakResult!.summary,
    verdict,
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receiptData)).digest("hex");
  await writeFile(summaryPath, JSON.stringify({ ...receiptData, receipt_sha256: receiptSha256 }, null, 2), "utf8");
  if (mode === "staging" && propagationSummary) {
    const propagationData = {
      qa_item: "QA-011-RP",
      mode,
      evidence_class: evidenceClass,
      slo_definition_version: CURRENT_SLO_DEFINITION_VERSION,
      candidate_sha: candidateSha ?? null,
      deployed_sha: deployedSha ?? null,
      competition_id: competitionId ?? null,
      target_url: baseUrl ?? null,
      title: "Result Propagation Staging Summary",
      target_p95_budget_ms: RESULT_PROPAGATION_P95_MS,
      minimum_samples_threshold: MINIMUM_SAMPLES_THRESHOLD,
      minimum_sessions_threshold: MINIMUM_SESSIONS_THRESHOLD,
      observed_session_count: activeSessions.length,
      observation_window: observationWindow(startedAt, new Date()),
      peak_summary: propagationSummary,
      verdict: "PASS",
      generated_at: new Date().toISOString(),
    };
    const digest = createHash("sha256").update(JSON.stringify(propagationData)).digest("hex");
    await writeFile(
      path.join(artifactDir, "qa-011-result-propagation-summary.json"),
      JSON.stringify({ ...propagationData, receipt_sha256: digest }, null, 2),
      "utf8",
    );
  }
  console.log(`[QA-011] ${verdict}: ${summaryPath}`);

  if (app) await app.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[QA-011] FAILED", error);
    process.exit(1);
  });
}
