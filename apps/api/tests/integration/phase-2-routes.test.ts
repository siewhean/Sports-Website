import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { ScoringAccessRejectedError, type Phase2Runtime } from "../../src/phase-2-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authenticatedIdentityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => ({
      account: {
        id: "00000000-0000-4000-8000-000000000001",
        primaryEmail: "organiser@phase2.test",
        displayName: "Organiser",
        status: "active",
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      sessionId: "identity-session",
      sessionToken: token,
      csrfToken: "csrf-ok",
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    })),
    verifyCsrfToken: vi.fn((_token: string, csrf: string) => csrf === "csrf-ok"),
  } as unknown as IdentityApiRuntime;
}

function routeRuntime() {
  return {
    createCompetition: vi.fn(async () => ({ id: randomUUID(), status: "draft", sport_code: "canoe_polo" })),
    competitionWorkspace: vi.fn(async () => ({
      competition: { id: randomUUID(), name: "Singapore Open" },
      access_passes: [{ id: randomUUID(), expires_at: "2026-08-01T00:00:00.000Z", revoked_at: null }],
    })),
    scoringSessionState: vi.fn(async () => ({
      competition: { slug: "singapore-open" },
      match: {
        id: randomUUID(),
        code: "group-A-r1-m1",
        stage: "group",
        state: "in_progress",
        home: { id: randomUUID(), name: "Marina Blue" },
        away: { id: randomUUID(), name: "Harbour Gold" },
      },
      access: {
        mode: "writer",
        permissions: ["score:read", "score:write", "score:reverse", "score:finalise"],
        session_expires_at: "2026-08-01T00:00:00.000Z",
      },
      writer: { generation: 1, expires_at: "2026-08-01T00:00:00.000Z", read_only: false },
      score: { home: 1, away: 0 },
      through_sequence: 2,
      events: [],
    })),
    exchangeAccess: vi.fn(async () => ({
      session_id: randomUUID(),
      session_token: "s".repeat(43),
      match_id: randomUUID(),
      generation: 1,
      expires_at: "2026-08-01T00:00:00.000Z",
      rate_limit: { limit: 5, remaining: 5, resetSeconds: 600 },
    })),
    publicCompetition: vi.fn(async () => ({
      competition: {
        id: randomUUID(),
        name: "Singapore Open",
        slug: "singapore-open",
        sport_code: "canoe_polo",
        timezone: "Asia/Singapore",
        starts_on: "2026-08-01",
        ends_on: "2026-08-01",
        status: "active",
      },
      division: { id: randomUUID(), name: "Open" },
      publication: { schedule_version: 1, result_version: 2 },
      schedule: [],
      results: [],
      standings: null,
      bracket: null,
      last_updated_at: "2026-07-17T00:00:00.000Z",
    })),
  };
}

describe("Phase 2 Fastify route boundaries", () => {
  it("enforces organiser origin, session and CSRF before mutation and excludes access secrets from reads", async () => {
    const runtime = routeRuntime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: authenticatedIdentityRuntime(),
      phase2Runtime: runtime as unknown as Phase2Runtime,
    });
    apps.push(app);
    const payload = {
      organisation_id: randomUUID(),
      name: "Singapore Open",
      slug: "singapore-open",
      timezone: "Asia/Singapore",
      starts_on: "2026-08-01",
      ends_on: "2026-08-01",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions",
          headers: { origin: "https://attacker.example" },
          payload,
        })
      ).json().error.code,
    ).toBe("ORIGIN_REJECTED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions",
          headers: { origin: "http://127.0.0.1:3000" },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions",
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie: "matchday_session=session-token",
            "x-csrf-token": "wrong",
          },
          payload,
        })
      ).json().error.code,
    ).toBe("CSRF_INVALID");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: { origin: "http://127.0.0.1:3000", cookie: "matchday_session=session-token", "x-csrf-token": "csrf-ok" },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(runtime.createCompetition).toHaveBeenCalledOnce();

    const workspace = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${randomUUID()}`,
      headers: { cookie: "matchday_session=session-token" },
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.body).not.toContain("session_token");
    expect(workspace.body).not.toContain("short_code");
    expect(workspace.body).not.toContain('"token"');
  });

  it("validates scoring headers, exposes access-limit headers, and leaves the public projection unauthenticated", async () => {
    const runtime = routeRuntime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: authenticatedIdentityRuntime(),
      phase2Runtime: runtime as unknown as Phase2Runtime,
      anonymousRateLimitMax: 100,
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/scoring/session" })).statusCode).toBe(400);
    const scoring = await app.inject({
      method: "GET",
      url: "/api/v1/scoring/session",
      headers: {
        "x-scoring-session-id": randomUUID(),
        "x-scoring-session-token": "t".repeat(43),
        "x-writer-generation": "1",
      },
    });
    expect(scoring.statusCode).toBe(200);
    expect(scoring.headers["cache-control"]).toBe("no-store, private");
    expect(scoring.json()).toMatchObject({ competition: { slug: "singapore-open" } });

    const exchange = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/scoring/access/exchange",
        payload: { token: "q".repeat(43), device_id: "d".repeat(43) },
      });
    runtime.exchangeAccess.mockRejectedValueOnce(
      new ScoringAccessRejectedError(403, "ACCESS_DENIED", "Access is invalid", {
        limit: 5,
        remaining: 4,
        resetSeconds: 600,
      }),
    );
    const invalidExchange = await exchange();
    expect(invalidExchange.statusCode).toBe(403);
    expect(invalidExchange.headers["ratelimit-limit"]).toBe("5");
    expect(invalidExchange.headers["ratelimit-remaining"]).toBe("4");
    expect(invalidExchange.headers["ratelimit-reset"]).toBe("600");
    expect(invalidExchange.headers["retry-after"]).toBeUndefined();
    const exchanged = await exchange();
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.headers["ratelimit-limit"]).toBe("5");
    expect(exchanged.headers["ratelimit-remaining"]).toBe("5");
    const tooLongDeviceLabel = await app.inject({
      method: "POST",
      url: "/api/v1/scoring/access/exchange",
      payload: { token: "q".repeat(43), device_id: "d".repeat(43), device_label: "x".repeat(81) },
    });
    expect(tooLongDeviceLabel.statusCode).toBe(400);
    const maximumDeviceLabel = await app.inject({
      method: "POST",
      url: "/api/v1/scoring/access/exchange",
      payload: { token: "q".repeat(43), device_id: "d".repeat(43), device_label: "x".repeat(80) },
    });
    expect(maximumDeviceLabel.statusCode).toBe(200);
    expect(runtime.exchangeAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceLabel: "x".repeat(80) }),
      expect.any(String),
    );

    const publicView = await app.inject({ method: "GET", url: "/api/v1/public/competitions/singapore-open" });
    expect(publicView.statusCode).toBe(200);
    expect(publicView.headers["cache-control"]).toContain("public");
    expect(publicView.json()).toMatchObject({
      competition: { name: "Singapore Open", status: "active" },
      division: { name: "Open" },
      publication: { schedule_version: 1, result_version: 2 },
    });
    expect(publicView.body).not.toContain("primary_email");
    expect(publicView.body).not.toContain("session_token");
  });
});
