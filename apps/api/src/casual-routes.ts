import { createHash, randomBytes } from "node:crypto";
import { SPORT_PACKS, type SportId } from "@matchday/domain";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";

type Settings = {
  sport_id: SportId;
  home_name: string;
  away_name: string;
  target_points?: number;
  best_of_sets?: number;
  period_minutes?: number;
};
type GameRow = Settings & {
  id: string;
  owner_account_id: string | null;
  home_score: number;
  away_score: number;
  home_sets: number;
  away_sets: number;
  current_set: number;
  sets: { home: number; away: number }[];
  elapsed_seconds: number;
  timer_started_at: Date | null;
  status: "live" | "final";
  host_token_hash: string;
  viewer_token_hash: string;
  version: number;
  updated_at: Date;
};
type State = Pick<
  GameRow,
  | "home_score"
  | "away_score"
  | "home_sets"
  | "away_sets"
  | "current_set"
  | "sets"
  | "elapsed_seconds"
  | "timer_started_at"
  | "status"
>;
const Sport = Type.Union([
  Type.Literal("canoe_polo"),
  Type.Literal("badminton"),
  Type.Literal("table_tennis"),
  Type.Literal("volleyball"),
  Type.Literal("basketball"),
]);
const SettingsBody = Type.Object(
  {
    sport_id: Sport,
    home_name: Type.String({ minLength: 1, maxLength: 60 }),
    away_name: Type.String({ minLength: 1, maxLength: 60 }),
    target_points: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
    best_of_sets: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
    period_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  },
  { additionalProperties: false },
);
const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const freshToken = () => randomBytes(32).toString("base64url");
const notFound = () => new ApiError(404, ErrorCode.NOT_FOUND, "Casual game not found");
const invalid = (message: string) => new ApiError(400, ErrorCode.VALIDATION_ERROR, message);

export function normalizeCasualSettings(input: Settings): Settings {
  const pack = SPORT_PACKS[input.sport_id];
  if (!pack) throw invalid("Unsupported sport");
  const timed = pack.matchStructure.kind === "timed_periods";
  if (!input.home_name.trim() || !input.away_name.trim()) throw invalid("Team names are required");
  if (input.home_name.trim() === input.away_name.trim()) throw invalid("Team names must differ");
  if (timed && (input.target_points !== undefined || input.best_of_sets !== undefined))
    throw invalid("Timed sport settings cannot include sets or target points");
  if (!timed && input.period_minutes !== undefined) throw invalid("Set sport settings cannot include period length");
  if (input.best_of_sets !== undefined && ![1, 3, 5, 7].includes(input.best_of_sets))
    throw invalid("Best of sets must be 1, 3, 5 or 7");
  return {
    sport_id: input.sport_id,
    home_name: input.home_name.trim(),
    away_name: input.away_name.trim(),
    ...(timed
      ? { period_minutes: input.period_minutes ?? pack.matchStructure.segmentDurationMinutes ?? 10 }
      : {
          target_points: input.target_points ?? pack.matchStructure.targetPoints?.[0] ?? 11,
          best_of_sets: input.best_of_sets ?? pack.matchStructure.regulationSegments,
        }),
  };
}
function state(row: GameRow): State {
  return {
    home_score: row.home_score,
    away_score: row.away_score,
    home_sets: row.home_sets,
    away_sets: row.away_sets,
    current_set: row.current_set,
    sets: row.sets,
    elapsed_seconds: row.elapsed_seconds,
    timer_started_at: row.timer_started_at,
    status: row.status,
  };
}
function presentation(row: GameRow) {
  const now = Date.now();
  return {
    id: row.id,
    sport_id: row.sport_id,
    home_name: row.home_name,
    away_name: row.away_name,
    target_points: row.target_points,
    best_of_sets: row.best_of_sets,
    period_minutes: row.period_minutes,
    home_score: row.home_score,
    away_score: row.away_score,
    home_sets: row.home_sets,
    away_sets: row.away_sets,
    current_set: row.current_set,
    sets: row.sets,
    elapsed_seconds:
      row.elapsed_seconds +
      (row.timer_started_at ? Math.max(0, Math.floor((now - new Date(row.timer_started_at).getTime()) / 1000)) : 0),
    timer_running: !!row.timer_started_at,
    timer_started_at: row.timer_started_at,
    status: row.status,
    version: row.version,
    updated_at: new Date(row.updated_at).toISOString(),
    observed_at: new Date(now).toISOString(),
  };
}
function requireHost(request: FastifyRequest): string {
  const token = request.headers["x-casual-host-token"];
  if (typeof token !== "string" || token.length < 32 || token.length > 128) throw notFound();
  return tokenHash(token);
}
async function actor(request: FastifyRequest, identity: IdentityRequestContext, mutating = true) {
  const session = await identity.authenticate(request);
  if (mutating && request.headers["x-csrf-token"] !== session.csrfToken)
    throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
  return session.account.id;
}

export async function registerCasualRoutes(
  app: FastifyInstance,
  options: { sql: postgres.Sql; identityRequests?: IdentityRequestContext },
) {
  const sql = options.sql;
  const readGame = async (id: string, hash: string, host = false): Promise<GameRow> => {
    const rows = await sql<
      GameRow[]
    >`SELECT * FROM casual_games WHERE id=${id} AND ${host ? sql`host_token_hash=${hash}` : sql`viewer_token_hash=${hash}`}`;
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const account = async (request: FastifyRequest, mutating = true) => {
    if (!options.identityRequests) throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Sign in required");
    return actor(request, options.identityRequests, mutating);
  };
  app.post<{ Body: Settings }>(
    "/api/v1/casual/games",
    { schema: { body: SettingsBody, tags: ["casual-games"] } },
    async (request, reply) => {
      const settings = normalizeCasualSettings(request.body);
      const host_token = freshToken(),
        viewer_token = freshToken();
      const rows = await sql<
        GameRow[]
      >`INSERT INTO casual_games(sport_id,home_name,away_name,target_points,best_of_sets,period_minutes,host_token_hash,viewer_token_hash) VALUES(${settings.sport_id},${settings.home_name},${settings.away_name},${settings.target_points ?? null},${settings.best_of_sets ?? null},${settings.period_minutes ?? null},${tokenHash(host_token)},${tokenHash(viewer_token)}) RETURNING *`;
      reply.code(201).header("Cache-Control", "no-store");
      return { game: presentation(rows[0]!), host_token, viewer_token };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { viewer_token?: string } }>(
    "/api/v1/casual/games/:id",
    {
      schema: {
        params: IdParams,
        querystring: Type.Object({ viewer_token: Type.Optional(Type.String()) }),
        tags: ["casual-games"],
      },
    },
    async (request, reply) => {
      const host = request.headers["x-casual-host-token"];
      const viewer = request.headers["x-casual-viewer-token"] ?? request.query.viewer_token;
      const token = typeof host === "string" ? host : viewer;
      if (typeof token === "string" && token.length >= 32 && token.length <= 128) {
        const game = await readGame(request.params.id, tokenHash(token), typeof host === "string");
        reply.header("Cache-Control", "no-store");
        return presentation(game);
      }
      const accountId = await account(request, false);
      const rows = await sql<
        GameRow[]
      >`SELECT g.* FROM casual_games g WHERE g.id=${request.params.id} AND (g.owner_account_id=${accountId} OR EXISTS (SELECT 1 FROM casual_game_shares s WHERE s.game_id=g.id AND s.recipient_id=${accountId}))`;
      if (!rows[0]) throw notFound();
      reply.header("Cache-Control", "no-store");
      return presentation(rows[0]);
    },
  );
  const mutate = async (
    id: string,
    hash: string,
    kind: "score" | "undo" | "timer" | "finish",
    payload: { side?: "home" | "away"; points?: number; running?: boolean },
  ) =>
    sql.begin(async (tx) => {
      const rows = await tx<
        GameRow[]
      >`SELECT * FROM casual_games WHERE id=${id} AND host_token_hash=${hash} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw notFound();
      if (row.status === "final" && kind !== "undo") throw new ApiError(409, ErrorCode.CONFLICT, "Game is finished");
      let lastScoreVersion: number | undefined;
      const before = state(row);
      const next: State = { ...before, sets: [...row.sets] };
      if (kind === "score") {
        const side = payload.side!;
        const points = payload.points ?? 1;
        if (!SPORT_PACKS[row.sport_id].scoreStructure.allowedIncrements.includes(points))
          throw invalid("Points are not allowed for this sport");
        if (side === "home") next.home_score += points;
        else next.away_score += points;
        if (row.target_points && row.best_of_sets) {
          const winBy = SPORT_PACKS[row.sport_id].matchStructure.winBy ?? 1;
          const high = Math.max(next.home_score, next.away_score),
            low = Math.min(next.home_score, next.away_score);
          const pointCap = SPORT_PACKS[row.sport_id].matchStructure.pointCap;
          if (
            (high >= row.target_points && high - low >= winBy) ||
            (pointCap !== null && pointCap !== undefined && high >= pointCap)
          ) {
            next.sets.push({ home: next.home_score, away: next.away_score });
            if (next.home_score > next.away_score) next.home_sets++;
            else next.away_sets++;
            if (Math.max(next.home_sets, next.away_sets) >= Math.ceil(row.best_of_sets / 2)) {
              next.status = "final";
              if (row.timer_started_at)
                next.elapsed_seconds += Math.max(
                  0,
                  Math.floor((Date.now() - new Date(row.timer_started_at).getTime()) / 1000),
                );
              next.timer_started_at = null;
            } else {
              next.current_set++;
              next.home_score = 0;
              next.away_score = 0;
            }
          }
        }
      } else if (kind === "undo") {
        const last = await tx<
          { version: number; before_state: State }[]
        >`SELECT version,before_state FROM casual_game_actions WHERE game_id=${id} AND kind='score' AND version NOT IN (SELECT (after_state->>'undone_version')::integer FROM casual_game_actions WHERE game_id=${id} AND kind='undo') ORDER BY version DESC LIMIT 1`;
        if (!last[0]) throw new ApiError(409, ErrorCode.CONFLICT, "No score to undo");
        lastScoreVersion = last[0].version;
        const prior = last[0].before_state;
        Object.assign(next, {
          home_score: prior.home_score,
          away_score: prior.away_score,
          home_sets: prior.home_sets,
          away_sets: prior.away_sets,
          current_set: prior.current_set,
          sets: prior.sets,
          status: prior.status,
        });
      } else if (kind === "timer") {
        if (payload.running && !row.timer_started_at) next.timer_started_at = new Date();
        if (!payload.running && row.timer_started_at) {
          next.elapsed_seconds += Math.max(
            0,
            Math.floor((Date.now() - new Date(row.timer_started_at).getTime()) / 1000),
          );
          next.timer_started_at = null;
        }
      } else {
        if (row.timer_started_at)
          next.elapsed_seconds += Math.max(
            0,
            Math.floor((Date.now() - new Date(row.timer_started_at).getTime()) / 1000),
          );
        next.timer_started_at = null;
        next.status = "final";
      }
      const version = row.version + 1;
      const updated = await tx<
        GameRow[]
      >`UPDATE casual_games SET home_score=${next.home_score},away_score=${next.away_score},home_sets=${next.home_sets},away_sets=${next.away_sets},current_set=${next.current_set},sets=${tx.json(next.sets)},elapsed_seconds=${next.elapsed_seconds},timer_started_at=${next.timer_started_at},status=${next.status},version=${version},updated_at=now() WHERE id=${id} RETURNING *`;
      const after = { ...next, ...(kind === "undo" ? { undone_version: lastScoreVersion } : {}) };
      await tx`INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state) VALUES(${id},${version},${kind},${tx.json(before)},${tx.json(after)})`;
      return presentation(updated[0]!);
    });
  app.post<{ Params: { id: string }; Body: { side: "home" | "away"; points?: number } }>(
    "/api/v1/casual/games/:id/actions",
    {
      schema: {
        params: IdParams,
        body: Type.Object({
          side: Type.Union([Type.Literal("home"), Type.Literal("away")]),
          points: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
        }),
        tags: ["casual-games"],
      },
    },
    async (request) => mutate(request.params.id, requireHost(request), "score", request.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/casual/games/:id/undo",
    { schema: { params: IdParams, tags: ["casual-games"] } },
    async (request) => mutate(request.params.id, requireHost(request), "undo", {}),
  );
  app.post<{ Params: { id: string }; Body: { running: boolean } }>(
    "/api/v1/casual/games/:id/timer",
    { schema: { params: IdParams, body: Type.Object({ running: Type.Boolean() }), tags: ["casual-games"] } },
    async (request) => mutate(request.params.id, requireHost(request), "timer", request.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/casual/games/:id/finish",
    { schema: { params: IdParams, tags: ["casual-games"] } },
    async (request) => mutate(request.params.id, requireHost(request), "finish", {}),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/casual/games/:id/claim",
    { schema: { params: IdParams, tags: ["casual-games"] } },
    async (request) => {
      const accountId = await account(request);
      const hash = requireHost(request);
      const rows = await sql<
        GameRow[]
      >`UPDATE casual_games SET owner_account_id=${accountId},updated_at=now() WHERE id=${request.params.id} AND host_token_hash=${hash} AND (owner_account_id IS NULL OR owner_account_id=${accountId}) RETURNING *`;
      if (!rows[0]) throw notFound();
      return presentation(rows[0]);
    },
  );
  app.get("/api/v1/casual/me/games", { schema: { tags: ["casual-games"] } }, async (request) => {
    const accountId = await account(request, false);
    const rows = await sql<
      GameRow[]
    >`SELECT * FROM casual_games WHERE owner_account_id=${accountId} ORDER BY created_at DESC LIMIT 100`;
    return rows.map(presentation);
  });
  app.get("/api/v1/casual/me/presets", { schema: { tags: ["casual-games"] } }, async (request) => {
    const accountId = await account(request, false);
    return sql`SELECT id,name,settings,created_at FROM casual_game_presets WHERE owner_account_id=${accountId} ORDER BY created_at DESC LIMIT 100`;
  });
  app.post<{ Body: { name: string; settings: Settings } }>(
    "/api/v1/casual/me/presets",
    {
      schema: {
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), settings: SettingsBody }),
        tags: ["casual-games"],
      },
    },
    async (request, reply) => {
      const accountId = await account(request);
      const settings = normalizeCasualSettings(request.body.settings);
      const rows =
        await sql`INSERT INTO casual_game_presets(owner_account_id,name,settings) VALUES(${accountId},${request.body.name.trim()},${sql.json(settings)}) RETURNING id,name,settings,created_at`;
      reply.code(201);
      return rows[0];
    },
  );
  app.get("/api/v1/casual/friends", { schema: { tags: ["casual-games"] } }, async (request) => {
    const accountId = await account(request, false);
    return sql`SELECT a.id,a.display_name FROM casual_friend_requests f JOIN accounts a ON a.id=CASE WHEN f.sender_id=${accountId} THEN f.recipient_id ELSE f.sender_id END WHERE (f.sender_id=${accountId} OR f.recipient_id=${accountId}) AND f.status='accepted' ORDER BY a.display_name`;
  });
  app.get("/api/v1/casual/friends/requests", { schema: { tags: ["casual-games"] } }, async (request) => {
    const accountId = await account(request, false);
    return sql`SELECT f.id,f.sender_id,f.recipient_id,f.status,f.created_at,a.display_name AS sender_name FROM casual_friend_requests f JOIN accounts a ON a.id=f.sender_id WHERE f.recipient_id=${accountId} AND f.status='pending' ORDER BY f.created_at DESC`;
  });
  app.post<{ Body: { recipient_email: string } }>(
    "/api/v1/casual/friends/requests",
    {
      schema: {
        body: Type.Object({ recipient_email: Type.String({ format: "email", maxLength: 254 }) }),
        tags: ["casual-games"],
      },
    },
    async (request, reply) => {
      const accountId = await account(request);
      const users = await sql<
        { id: string }[]
      >`SELECT id FROM accounts WHERE lower(primary_email)=lower(${request.body.recipient_email}) AND status='active' AND deleted_at IS NULL`;
      const target = users[0];
      if (!target || target.id === accountId) throw new ApiError(404, ErrorCode.NOT_FOUND, "Account not found");
      const existing =
        await sql`SELECT 1 FROM casual_friend_requests WHERE (sender_id=${accountId} AND recipient_id=${target.id}) OR (sender_id=${target.id} AND recipient_id=${accountId})`;
      if (existing.length) throw new ApiError(409, ErrorCode.CONFLICT, "Friend request already exists");
      const rows =
        await sql`INSERT INTO casual_friend_requests(sender_id,recipient_id) VALUES(${accountId},${target.id}) RETURNING id,sender_id,recipient_id,status,created_at`;
      reply.code(201);
      return rows[0];
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/casual/friends/requests/:id/accept",
    { schema: { params: IdParams, tags: ["casual-games"] } },
    async (request) => {
      const accountId = await account(request);
      const rows =
        await sql`UPDATE casual_friend_requests SET status='accepted',updated_at=now() WHERE id=${request.params.id} AND recipient_id=${accountId} AND status='pending' RETURNING id,sender_id,recipient_id,status`;
      if (!rows[0]) throw notFound();
      return rows[0];
    },
  );
  app.post<{ Params: { id: string }; Body: { friend_account_id: string } }>(
    "/api/v1/casual/games/:id/share",
    {
      schema: {
        params: IdParams,
        body: Type.Object({ friend_account_id: Type.String({ format: "uuid" }) }),
        tags: ["casual-games"],
      },
    },
    async (request) => {
      const accountId = await account(request);
      const owned =
        await sql`SELECT 1 FROM casual_games WHERE id=${request.params.id} AND owner_account_id=${accountId}`;
      if (!owned.length) throw notFound();
      const friendship =
        await sql`SELECT 1 FROM casual_friend_requests WHERE status='accepted' AND ((sender_id=${accountId} AND recipient_id=${request.body.friend_account_id}) OR (sender_id=${request.body.friend_account_id} AND recipient_id=${accountId}))`;
      if (!friendship.length) throw new ApiError(403, ErrorCode.CONFLICT, "Friendship required");
      await sql`INSERT INTO casual_game_shares(game_id,recipient_id) VALUES(${request.params.id},${request.body.friend_account_id}) ON CONFLICT DO NOTHING`;
      return { shared: true };
    },
  );
  app.get("/api/v1/casual/friends/shared-games", { schema: { tags: ["casual-games"] } }, async (request) => {
    const accountId = await account(request, false);
    const rows = await sql<
      GameRow[]
    >`SELECT g.* FROM casual_game_shares s JOIN casual_games g ON g.id=s.game_id WHERE s.recipient_id=${accountId} ORDER BY s.shared_at DESC LIMIT 100`;
    return rows.map(presentation);
  });
}
