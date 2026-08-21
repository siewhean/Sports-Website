import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { ApiError } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import type { Phase4Runtime } from "../../src/phase-4-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function identityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => ({
      account: {
        id: randomUUID(),
        primaryEmail: "phase4@example.test",
        displayName: "Phase 4",
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

function mutationHeaders() {
  return {
    origin: "http://localhost:3000",
    "x-csrf-token": "csrf-ok",
    cookie: "matchday_session=session-token",
  };
}

function constraints(areaId: string) {
  const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
  return {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({ target_start_epoch_ms: 0, tolerance_minutes: 60 }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: areaId, match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 1 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  };
}

function runtime() {
  return {
    acceptScheduleOption: vi.fn(async () => ({ id: randomUUID(), status: "ready_for_review" })),
    moveScheduleMatch: vi.fn(async () => ({ id: randomUUID(), status: "ready_for_review", consequences: {} })),
    publishScheduleRevision: vi.fn(async () => ({ id: randomUUID(), status: "published", schedule_version: 2 })),
    generateSchedule: vi.fn(async () => ({
      job: { id: randomUUID() },
      enqueued: false,
      recoverable: true,
      idempotent_replay: false,
    })),
    runScheduleMaintenance: vi.fn(async () => ({
      warnings_emitted: 1,
      revisions_expired: 1,
      queued_jobs_pending_recovery: 0,
    })),
    recoverQueuedScheduleJobs: vi.fn(async () => ({ recovered: 0, failed: 0 })),
    archiveFormatTemplate: vi.fn(async () => {
      throw new ApiError(409, "TEMPLATE_ARCHIVED", "Template is already archived");
    }),
  } as unknown as Phase4Runtime;
}

describe("Phase 4 authenticated route boundary", () => {
  it("guards and dispatches schedule accept, move, and publication mutations", async () => {
    const phase4 = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase4Runtime: phase4,
    });
    apps.push(app);
    const jobId = randomUUID();
    const optionId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyKey = randomUUID();

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/schedule-jobs/${jobId}/options/${optionId}/accept`,
      headers: { ...mutationHeaders(), origin: "https://evil.example" },
      payload: { idempotency_key: idempotencyKey, expected_job_revision: 1 },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("ORIGIN_REJECTED");
    expect(phase4.acceptScheduleOption).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/schedule-jobs/${jobId}/options/${optionId}/accept`,
      headers: mutationHeaders(),
      payload: { idempotency_key: idempotencyKey, expected_job_revision: 1 },
    });
    expect(accepted.statusCode).toBe(201);
    expect(phase4.acceptScheduleOption).toHaveBeenCalledOnce();

    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/schedule-revisions/${revisionId}/moves`,
      headers: mutationHeaders(),
      payload: {
        idempotency_key: randomUUID(),
        expected_revision: 1,
        match_id: randomUUID(),
        playing_area_id: randomUUID(),
        slot_id: `${randomUUID()}:1`,
        start_epoch_ms: 1_817_078_400_000,
        end_epoch_ms: 1_817_080_200_000,
      },
    });
    expect(moved.statusCode).toBe(201);
    expect(phase4.moveScheduleMatch).toHaveBeenCalledOnce();

    const published = await app.inject({
      method: "POST",
      url: `/api/v1/schedule-revisions/${revisionId}/publish`,
      headers: mutationHeaders(),
      payload: { idempotency_key: randomUUID(), expected_revision: 1 },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: "published", schedule_version: 2 });
  });

  it("documents recoverable queue failure, archive conflict, and structured 404 behavior", async () => {
    const phase4 = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase4Runtime: phase4,
    });
    apps.push(app);
    const areaId = randomUUID();
    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${randomUUID()}/schedule-jobs`,
      headers: mutationHeaders(),
      payload: {
        idempotency_key: randomUUID(),
        expected_source_revision: 1,
        expected_capacity_revision: 1,
        objective: "balanced",
        constraints: constraints(areaId),
      },
    });
    expect(generated.statusCode).toBe(503);
    expect(generated.json().error).toMatchObject({ code: "SCHEDULE_QUEUE_UNAVAILABLE" });

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/organisations/${randomUUID()}/format-templates/${randomUUID()}/archive`,
      headers: mutationHeaders(),
      payload: { idempotency_key: randomUUID(), expected_status: "active" },
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe("TEMPLATE_ARCHIVED");

    const missing = await app.inject({ method: "GET", url: "/api/v1/phase4/not-a-route" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: "ROUTE_NOT_FOUND" });
  });

  it("keeps expiry maintenance hidden behind the operational token", async () => {
    const phase4 = runtime();
    const app = await buildApp({
      config: { ...testConfig(), deepHealthToken: "phase4-maintenance-secret" },
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase4Runtime: phase4,
    });
    apps.push(app);

    const hidden = await app.inject({ method: "POST", url: "/internal/phase4/schedule-maintenance" });
    expect(hidden.statusCode).toBe(404);
    expect(phase4.runScheduleMaintenance).not.toHaveBeenCalled();

    const maintained = await app.inject({
      method: "POST",
      url: "/internal/phase4/schedule-maintenance",
      headers: { "x-deep-health-token": "phase4-maintenance-secret" },
    });
    expect(maintained.statusCode).toBe(200);
    expect(maintained.json()).toMatchObject({ warnings_emitted: 1, revisions_expired: 1 });
    expect(phase4.runScheduleMaintenance).toHaveBeenCalledOnce();
    expect(phase4.recoverQueuedScheduleJobs).toHaveBeenCalledOnce();
  });
});
