import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { buildApp } from "../../src/app.js";
import { ApiError, ErrorCode } from "../../src/errors.js";
import {
  CASUAL_MAX_FRIEND_REQUESTS_PER_DAY,
  CASUAL_MAX_PRESETS_PER_ACCOUNT,
  purgeExpiredCasualGames,
} from "../../src/casual-routes.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL!;
const schema = `test_casual_${randomUUID().replaceAll("-", "")}`;
let sql: Sql;
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId: string;
let friendId: string;
let strangerId: string;
const identityHeaders = (token = "owner") => ({
  cookie: `matchday_session=${token}`,
  "x-csrf-token": `csrf-${token}`,
  origin: "http://localhost:3000",
});
type Created = { game: { id: string }; host_token: string; viewer_token: string };

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl,
    schema,
    migrationsDirectory: fileURLToPath(new URL("../../../../packages/database/migrations", import.meta.url)),
  });
  sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });
  const accounts = await sql<
    { id: string }[]
  >`INSERT INTO accounts(primary_email,display_name,email_verified_at) VALUES('casual-owner@matchday.test','Owner',now()),('casual-friend@matchday.test','Friend',now()),('casual-stranger@matchday.test','Stranger',now()) RETURNING id`;
  [ownerId, friendId, strangerId] = accounts.map((account) => account.id) as [string, string, string];
  const ids: Record<string, string> = { owner: ownerId, friend: friendId, stranger: strangerId };
  const identity = {
    authenticate: vi.fn(async (token: string) => {
      if (!ids[token]) throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Sign in required");
      return {
        account: {
          id: ids[token],
          primaryEmail: `casual-${token}@matchday.test`,
          displayName: token,
          status: "active",
          emailVerifiedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        sessionId: randomUUID(),
        sessionToken: token,
        csrfToken: `csrf-${token}`,
        idleExpiresAt: new Date(Date.now() + 60000),
        absoluteExpiresAt: new Date(Date.now() + 60000),
      };
    }),
    verifyCsrfToken: vi.fn((token: string, csrf: string) => csrf === `csrf-${token}`),
  } as unknown as IdentityApiRuntime;
  app = await buildApp({
    config: testConfig({
      DATABASE_URL: databaseUrl,
      API_ALLOWED_ORIGINS: "http://localhost:3000",
      MATCHDAY_PUBLIC_ORIGIN: "http://localhost:3000",
    }),
    probes: healthyProbes,
    casualSql: sql,
    identityRuntime: identity,
    rateLimitMax: 10000,
  });
}, 30_000);
afterAll(async () => {
  await app?.close();
  await sql?.end();
  await dropTestSchema(databaseUrl, schema);
});
const create = async (settings: Record<string, unknown> = {}) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/casual/games",
    payload: { sport_id: "badminton", home_name: "Home", away_name: "Away", ...settings },
  });
  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toContain("no-store");
  return response.json<Created>();
};
const mutate = (game: Created, action: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/v1/casual/games/${game.game.id}/${action}`,
    headers: { "x-casual-host-token": game.host_token },
    payload,
  });
const watch = (game: Created) =>
  app.inject({ method: "GET", url: `/api/v1/casual/games/${game.game.id}?viewer_token=${game.viewer_token}` });

describe("real PostgreSQL casual game lifecycle", () => {
  it("creates each supported sport and keeps capability hashes private", async () => {
    for (const sport_id of ["badminton", "basketball", "canoe_polo", "table_tennis", "volleyball"]) {
      const game = await create({ sport_id });
      expect(game.host_token).not.toBe(game.viewer_token);
      const response = await watch(game);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sport_id, home_score: 0, version: 1 });
      expect(response.body).not.toContain("token_hash");
      expect(response.body).not.toContain(game.host_token);
      const persisted = await sql<
        { host_token_hash: string; viewer_token_hash: string }[]
      >`SELECT host_token_hash,viewer_token_hash FROM casual_games WHERE id=${game.game.id}`;
      expect(persisted[0]!.host_token_hash).not.toBe(game.host_token);
      expect(persisted[0]!.viewer_token_hash).not.toBe(game.viewer_token);
    }
  });

  it("serializes concurrent host scoring, updates viewers, and denies other capabilities", async () => {
    const game = await create({ sport_id: "basketball" });
    const other = await create();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => mutate(game, "actions", { side: "home", points: 2 })),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
    expect((await watch(game)).json()).toMatchObject({ home_score: 16, version: 9 });
    const deniedHeaders = [
      {},
      { "x-casual-host-token": game.viewer_token },
      { "x-casual-host-token": other.host_token },
    ];
    for (const headers of deniedHeaders) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/casual/games/${game.game.id}/actions`,
        headers,
        payload: { side: "away" },
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await watch(game)).json()).toMatchObject({ home_score: 16, away_score: 0, version: 9 });
    expect((await app.inject({ method: "GET", url: `/api/v1/casual/games/${game.game.id}` })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/casual/games/${game.game.id}?viewer_token=${other.viewer_token}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("supports undo and timer changes but cannot reopen an explicitly finished game", async () => {
    const game = await create({ sport_id: "basketball" });
    expect((await mutate(game, "timer", { running: true })).json()).toMatchObject({ timer_running: true });
    expect((await mutate(game, "actions", { side: "home", points: 3 })).statusCode).toBe(200);
    expect((await mutate(game, "undo")).json()).toMatchObject({ home_score: 0 });
    expect((await mutate(game, "actions", { side: "home" })).statusCode).toBe(200);
    expect((await mutate(game, "finish")).json()).toMatchObject({ status: "final", timer_running: false });
    for (const [action, payload] of [
      ["undo", {}],
      ["actions", { side: "home" }],
      ["timer", { running: true }],
    ] as const) {
      expect((await mutate(game, action, payload)).statusCode).toBe(409);
    }
    expect((await watch(game)).json()).toMatchObject({ status: "final", home_score: 1, timer_running: false });
  });

  it("respects custom targets above the standard cap and allows winning-point correction", async () => {
    const game = await create({ target_points: 31, best_of_sets: 1 });
    for (let point = 0; point < 30; point++)
      expect((await mutate(game, "actions", { side: "home" })).statusCode).toBe(200);
    expect((await watch(game)).json()).toMatchObject({ status: "live", home_score: 30 });
    expect((await mutate(game, "actions", { side: "home" })).json()).toMatchObject({
      status: "final",
      home_score: 31,
      home_sets: 1,
    });
    expect((await mutate(game, "undo")).json()).toMatchObject({ status: "live", home_score: 30, home_sets: 0 });
  });

  it("enforces claim, CSRF, accepted friendship and shared account read boundaries", async () => {
    const game = await create();
    const gameUrl = `/api/v1/casual/games/${game.game.id}`;
    const claim = await app.inject({
      method: "POST",
      url: `${gameUrl}/claim`,
      headers: { ...identityHeaders(), "x-casual-host-token": game.host_token },
      payload: {},
    });
    expect(claim.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${gameUrl}/claim`,
          headers: { ...identityHeaders("stranger"), "x-casual-host-token": game.host_token },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);

    const badCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/casual/me/presets",
      headers: { ...identityHeaders(), "x-csrf-token": "wrong" },
      payload: { name: "Saved", settings: { sport_id: "badminton", home_name: "A", away_name: "B" } },
    });
    expect(badCsrf.statusCode).toBe(403);
    const blockedShare = await app.inject({
      method: "POST",
      url: `${gameUrl}/share`,
      headers: identityHeaders(),
      payload: { friend_account_id: friendId },
    });
    expect(blockedShare.statusCode).toBe(403);
    const friendRequest = await app.inject({
      method: "POST",
      url: "/api/v1/casual/friends/requests",
      headers: identityHeaders(),
      payload: { recipient_email: "casual-friend@matchday.test" },
    });
    expect(friendRequest.statusCode).toBe(202);
    expect(friendRequest.json()).not.toHaveProperty("recipient_id");
    const pending = await app.inject({
      method: "GET",
      url: "/api/v1/casual/friends/requests",
      headers: identityHeaders("friend"),
    });
    const requestId = (pending.json() as { id: string }[])[0]!.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/casual/friends/requests/${requestId}/accept`,
          headers: identityHeaders("friend"),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${gameUrl}/share`,
          headers: identityHeaders(),
          payload: { friend_account_id: friendId },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: gameUrl, headers: identityHeaders("friend") })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: gameUrl, headers: identityHeaders("stranger") })).statusCode).toBe(
      404,
    );
    for (const url of [
      "/api/v1/casual/me/games",
      "/api/v1/casual/me/presets",
      "/api/v1/casual/friends",
      "/api/v1/casual/friends/requests",
      "/api/v1/casual/friends/shared-games",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: identityHeaders() });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
  });

  it("answers friend requests identically for unknown, own and real emails and caps daily sends", async () => {
    const send = (email: string, token = "stranger") =>
      app.inject({
        method: "POST",
        url: "/api/v1/casual/friends/requests",
        headers: identityHeaders(token),
        payload: { recipient_email: email },
      });
    const unknown = await send("nobody-here@matchday.test");
    const own = await send("casual-stranger@matchday.test");
    const real = await send("casual-owner@matchday.test");
    const duplicate = await send("casual-owner@matchday.test");
    for (const response of [unknown, own, real, duplicate]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(unknown.json());
    }
    // Only real deliveries count toward the cap, so unknown emails cannot be distinguished by it.
    const extra = await sql<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      SELECT 'casual-cap-' || g || '-' || ${randomUUID()} || '@matchday.test','Cap',now()
      FROM generate_series(1, ${CASUAL_MAX_FRIEND_REQUESTS_PER_DAY}) g RETURNING id`;
    await sql`INSERT INTO casual_friend_requests(sender_id,recipient_id)
      SELECT ${strangerId}, id FROM unnest(${sql.array(extra.slice(1).map((row) => row.id))}::uuid[]) id`;
    const capped = await send("casual-friend@matchday.test");
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe("RATE_LIMITED");
  });

  it("rejects friend requests and presets from a foreign origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/casual/me/presets",
      headers: { ...identityHeaders(), origin: "https://evil.example" },
      payload: { name: "Evil", settings: { sport_id: "badminton", home_name: "A", away_name: "B" } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_REJECTED");
  });

  it("caps saved presets per account", async () => {
    await sql`INSERT INTO casual_game_presets(owner_account_id,name,settings)
      SELECT ${friendId}, 'Preset ' || g, ${sql.json({ sport_id: "badminton", home_name: "A", away_name: "B" })}
      FROM generate_series(1, ${CASUAL_MAX_PRESETS_PER_ACCOUNT}) g`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/casual/me/presets",
      headers: identityHeaders("friend"),
      payload: { name: "One too many", settings: { sport_id: "badminton", home_name: "A", away_name: "B" } },
    });
    expect(response.statusCode).toBe(409);
  });

  it("hides and purges unclaimed games idle past the retention window", async () => {
    const stale = await create();
    const fresh = await create();
    await sql`UPDATE casual_games SET updated_at=now() - interval '31 days' WHERE id=${stale.game.id}`;
    const staleRead = await app.inject({
      method: "GET",
      url: `/api/v1/casual/games/${stale.game.id}`,
      headers: { "x-casual-viewer-token": stale.viewer_token },
    });
    expect(staleRead.statusCode).toBe(404);
    const staleWrite = await app.inject({
      method: "POST",
      url: `/api/v1/casual/games/${stale.game.id}/actions`,
      headers: { "x-casual-host-token": stale.host_token },
      payload: { side: "home" },
    });
    expect(staleWrite.statusCode).toBe(404);
    const purged = await purgeExpiredCasualGames(sql, new Date(Date.now() - 30 * 86_400_000));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await sql`SELECT 1 FROM casual_games WHERE id=${stale.game.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM casual_games WHERE id=${fresh.game.id}`).length).toBe(1);
  });
});
