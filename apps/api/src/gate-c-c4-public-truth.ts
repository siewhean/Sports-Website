import { createHash } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import type { PublicCompetitionFreshness, PublicProjectionFreshness } from "@matchday/contracts";
import { gateCC4PublicConditionalStatus, gateCC4PublicHeaders } from "./gate-c-public-http.js";

type PublicTruthRow = {
  payload: Record<string, unknown> | string;
  schedule_version: number;
  result_version: number;
  generated_at: Date | string;
  source_updated_at: Date | string;
  division_freshness: unknown | string;
};

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json(value: PublicTruthRow["payload"]): Record<string, unknown> {
  return typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Public truth contains an unsupported value");
  return encoded;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function jsonArray(value: PublicTruthRow["division_freshness"]): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function readDivisionFreshness(value: PublicTruthRow["division_freshness"]): PublicProjectionFreshness[] {
  return jsonArray(value).map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Public division freshness is malformed");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.division_id !== "string" ||
      typeof row.schedule_version !== "number" ||
      typeof row.result_version !== "number" ||
      typeof row.projection_version !== "number" ||
      !Number.isSafeInteger(row.schedule_version) ||
      !Number.isSafeInteger(row.result_version) ||
      !Number.isSafeInteger(row.projection_version) ||
      typeof row.generated_at !== "string" ||
      typeof row.source_updated_at !== "string" ||
      typeof row.etag !== "string"
    ) {
      throw new Error("Public division freshness is malformed");
    }
    return {
      division_id: row.division_id,
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: row.projection_version,
      generated_at: row.generated_at,
      source_updated_at: row.source_updated_at,
      etag: row.etag,
    };
  });
}

const Id = Type.String({ format: "uuid" });
const PublicParticipantSchema = strict({ id: Type.Union([Id, Type.Null()]), name: Type.String() });
const PublicScheduleSchema = strict({
  id: Id,
  code: Type.String(),
  stage: Type.String(),
  home: PublicParticipantSchema,
  away: PublicParticipantSchema,
  starts_at: Type.String({ format: "date-time" }),
  ends_at: Type.String({ format: "date-time" }),
  area: strict({ id: Id, name: Type.String() }),
});
const PublicResultSchema = strict({
  id: Id,
  code: Type.String(),
  stage: Type.String(),
  home: PublicParticipantSchema,
  away: PublicParticipantSchema,
  home_score: Type.Integer({ minimum: 0 }),
  away_score: Type.Integer({ minimum: 0 }),
  state: Type.Union([Type.Literal("final"), Type.Literal("corrected")]),
  updated_at: Type.String({ format: "date-time" }),
});
const PublicDivisionSchema = strict({
  division: strict({ id: Id, name: Type.String() }),
  schedule: Type.Array(PublicScheduleSchema),
  results: Type.Array(PublicResultSchema),
  standings: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  bracket: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
});
const DivisionFreshnessSchema = strict({
  division_id: Id,
  schedule_version: Type.Integer({ minimum: 0 }),
  result_version: Type.Integer({ minimum: 0 }),
  projection_version: Type.Integer({ minimum: 1 }),
  generated_at: Type.String({ format: "date-time" }),
  source_updated_at: Type.String({ format: "date-time" }),
  etag: Type.String({ minLength: 3, maxLength: 300 }),
});
const FreshnessSchema = strict({
  schedule_version: Type.Integer({ minimum: 0 }),
  result_version: Type.Integer({ minimum: 0 }),
  projection_version: Type.Integer({ minimum: 1 }),
  generated_at: Type.String({ format: "date-time" }),
  source_updated_at: Type.String({ format: "date-time" }),
  etag: Type.String({ minLength: 3, maxLength: 300 }),
  division_freshness: Type.Array(DivisionFreshnessSchema),
});
const PublicCurrentSchema = strict({
  competition: strict({
    id: Id,
    name: Type.String(),
    slug: Type.String(),
    sport_code: Type.Union([
      Type.Literal("canoe_polo"),
      Type.Literal("badminton"),
      Type.Literal("table_tennis"),
      Type.Literal("volleyball"),
      Type.Literal("basketball"),
    ]),
    timezone: Type.String(),
    starts_on: Type.String({ format: "date" }),
    ends_on: Type.String({ format: "date" }),
    status: Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("archived")]),
  }),
  divisions: Type.Array(PublicDivisionSchema, { minItems: 1 }),
  division: strict({ id: Id, name: Type.String() }),
  publication: strict({
    schedule_version: Type.Integer({ minimum: 0 }),
    result_version: Type.Integer({ minimum: 0 }),
  }),
  schedule: Type.Array(PublicScheduleSchema),
  results: Type.Array(PublicResultSchema),
  standings: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  bracket: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  last_updated_at: Type.String({ format: "date-time" }),
  freshness: FreshnessSchema,
  public_notices: Type.Array(Type.String()),
});
const PublicErrorSchema = strict({
  error: strict({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});

export class GateCC4PublicTruthRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  async read(slug: string): Promise<{
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    freshness: PublicCompetitionFreshness;
  } | null> {
    const row = (
      await this.sql.unsafe<PublicTruthRow>(
        `SELECT projection.projection AS payload,publication.schedule_version,publication.result_version,
                projection.generated_at,publication.updated_at AS source_updated_at,
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'division_id',division_projection.division_id,
                      'schedule_version',division_projection.schedule_version,
                      'result_version',division_projection.result_version,
                      'projection_version',division_projection.projection_version,
                      'generated_at',division_projection.generated_at,
                      'source_updated_at',division_projection.source_updated_at,
                      'etag',division_projection.etag
                    ) ORDER BY division_projection.division_id
                  ) FILTER (WHERE division_projection.id IS NOT NULL),
                  '[]'::jsonb
                ) AS division_freshness
         FROM competitions competition
         JOIN competition_publications publication ON publication.competition_id=competition.id
         JOIN public_competition_projections projection
           ON projection.competition_id=competition.id
          AND projection.schedule_version=publication.schedule_version
          AND projection.result_version=publication.result_version
         LEFT JOIN public_projection_versions division_projection
           ON division_projection.competition_id=competition.id
          AND division_projection.schedule_version=publication.schedule_version
          AND division_projection.result_version=publication.result_version
         WHERE competition.slug=$1
           AND competition.status IN ('active','completed','archived')
         GROUP BY projection.projection,publication.schedule_version,publication.result_version,
                  projection.generated_at,publication.updated_at`,
        [slug],
      )
    )[0];
    if (!row) return null;
    const divisionFreshness = readDivisionFreshness(row.division_freshness);
    const source = json(row.payload);
    const freshness: PublicCompetitionFreshness = {
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: Math.max(1, ...divisionFreshness.map((division) => division.projection_version)),
      generated_at: instant(row.generated_at),
      source_updated_at: instant(row.source_updated_at),
      etag: `c4-current-${sha256({
        payload: source,
        schedule_version: row.schedule_version,
        result_version: row.result_version,
        division_freshness: divisionFreshness,
      })}`,
      division_freshness: divisionFreshness,
    };
    const divisions = Array.isArray(source.divisions)
      ? source.divisions.map((division) =>
          division && typeof division === "object" && !Array.isArray(division)
            ? { ...(division as Record<string, unknown>), public_notices: [] }
            : division,
        )
      : source.divisions;
    const payload = {
      ...source,
      ...(divisions ? { divisions } : {}),
      freshness,
      public_notices: [],
      last_updated_at: freshness.source_updated_at,
    };
    assertPublicProjectionPrivacy(payload);
    return { payload, headers: gateCC4PublicHeaders(freshness), freshness };
  }
}

export async function registerGateCC4PublicTruthRoutes(app: FastifyInstance, runtime: GateCC4PublicTruthRuntime) {
  app.get<{ Params: { slug: string }; Headers: { "if-none-match"?: string; "if-modified-since"?: string } }>(
    "/api/v1/public/competitions/:slug/current",
    {
      schema: {
        params: strict({ slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }) }),
        headers: Type.Object(
          {
            "if-none-match": Type.Optional(Type.String({ maxLength: 1_000 })),
            "if-modified-since": Type.Optional(Type.String({ maxLength: 100 })),
          },
          { additionalProperties: true },
        ),
        response: { 200: PublicCurrentSchema, 304: Type.Null(), 404: PublicErrorSchema },
        tags: ["public", "gate-c-c4"],
      },
    },
    async (request, reply) => {
      const result = await runtime.read(request.params.slug);
      if (!result) {
        return reply
          .code(404)
          .send({ error: { code: "PUBLIC_COMPETITION_NOT_FOUND", message: "Competition not found" } });
      }
      for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
      const status = gateCC4PublicConditionalStatus(result.freshness, request.headers);
      if (status === 304) return reply.code(304).send();
      return result.payload;
    },
  );
}
