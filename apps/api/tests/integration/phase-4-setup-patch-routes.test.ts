import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Phase4SetupDocument } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import { buildApp } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "../../src/phase-4-reliable-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const competitionId = randomUUID();
const accountId = randomUUID();
const organisationId = randomUUID();
const stepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;

function document(revision = 2): Phase4SetupDocument {
  const now = "2026-07-22T00:00:00.000Z";
  return {
    schema_version: 1,
    id: randomUUID(),
    organisation_id: organisationId,
    competition_id: competitionId,
    competition_status: "draft",
    revision,
    status: "active",
    current_step: "basics",
    completed_steps: [],
    steps: stepIds.map((id, index) => ({
      id,
      status: index === 0 ? "current" : "not_started",
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: null,
    })),
    values: {
      basics: {
        name: "Boundary Cup",
        sport_code: "badminton",
        location: { venue: "Sports Hall", address: "1 Test Road", locality: null, country_code: "SG" },
        starts_on: "2027-01-01",
        ends_on: "2027-01-02",
        time_zone: "Asia/Singapore",
        locale: "en-SG",
        entry_count: 16,
        division_count: 1,
        entry_count_status: "estimated",
      },
      capacity: null,
      settings: null,
      entries: null,
      format_preferences: {
        minimum_matches: { per_entry: 3 },
        ranking: { rank_all_entries: true },
        knockout: { required: false },
        placement: { required: false },
        qualification: { cross_group_allowed: true },
        priority: { value: "participation" },
      },
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: false,
    autosave: { status: "saved", last_saved_at: now, expires_at: "2026-08-22T00:00:00.000Z" },
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

function identityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => ({
      account: {
        id: accountId,
        primaryEmail: "gate-b@example.test",
        displayName: "Gate B",
        status: "active",
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      sessionId: randomUUID(),
      sessionToken: token,
      csrfToken: "csrf-ok",
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    })),
    verifyCsrfToken: vi.fn((_token: string, csrf: string) => csrf === "csrf-ok"),
  } as unknown as IdentityApiRuntime;
}

function mutationHeaders(origin = "http://localhost:3000") {
  return {
    origin,
    "x-csrf-token": "csrf-ok",
    cookie: "matchday_session=session-token",
  };
}

function runtime() {
  const sql = {
    unsafe: vi.fn(async () => []),
    begin: vi.fn(async <T>(operation: (tx: PostgresJsSql) => Promise<T>) => operation(sql as unknown as PostgresJsSql)),
  } as unknown as PostgresJsSql;
  const phase3 = new Phase3Runtime(sql, phase3DomainAdapter);
  const gate = new ReliableGateBPhase4Runtime(
    sql,
    phase3,
    { enqueueSchedule: vi.fn(async () => ({ id: "ignored", name: "schedule.optimize", duplicate: false })) },
    { mode: "disabled", provider: null, timeoutMs: 1_000, maximumAttempts: 1, cacheTtlSeconds: 60 },
  );
  vi.spyOn(gate, "patchSetupDraft").mockResolvedValue({ outcome: "saved", document: document(3) });
  vi.spyOn(gate, "resumeSetupDraft").mockResolvedValue(document(2));
  return gate;
}

describe("Gate B setup route boundary", () => {
  it("authenticates and dispatches strict PATCH and resume commands", async () => {
    const gate = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase4Runtime: gate,
    });
    apps.push(app);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/competitions/${competitionId}/setup-draft`,
      headers: mutationHeaders(),
      payload: {
        expected_revision: 2,
        idempotency_key: randomUUID(),
        step: { step_id: "format_preferences", value: document().values.format_preferences },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ outcome: "saved", document: { revision: 3 } });
    expect(gate.patchSetupDraft).toHaveBeenCalledOnce();

    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/setup-draft/resume`,
      headers: mutationHeaders(),
      payload: { idempotency_key: randomUUID() },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ revision: 2, competition_id: competitionId });
    expect(gate.resumeSetupDraft).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin, missing-CSRF, and unknown-field requests before dispatch", async () => {
    const gate = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase4Runtime: gate,
    });
    apps.push(app);

    const crossOrigin = await app.inject({
      method: "PATCH",
      url: `/api/v1/competitions/${competitionId}/setup-draft`,
      headers: mutationHeaders("https://evil.example"),
      payload: {
        expected_revision: 2,
        idempotency_key: randomUUID(),
        step: { step_id: "format_preferences", value: document().values.format_preferences },
      },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/setup-draft/resume`,
      headers: { origin: "http://localhost:3000", cookie: "matchday_session=session-token" },
      payload: { idempotency_key: randomUUID() },
    });
    expect(noCsrf.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/setup-draft/resume`,
      headers: mutationHeaders(),
      payload: { idempotency_key: randomUUID(), browser_only: true },
    });
    expect(unknown.statusCode).toBe(400);
    expect(gate.patchSetupDraft).not.toHaveBeenCalled();
    expect(gate.resumeSetupDraft).not.toHaveBeenCalled();
  });
});
