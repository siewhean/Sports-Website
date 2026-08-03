import { createHash } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { PublicProjectionFreshness } from "@matchday/contracts";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import { gateCC4PublicConditionalStatus, gateCC4PublicHeaders } from "./gate-c-public-http.js";

type PublicTruthRow = {
  competition_id: string;
  payload: Record<string, unknown> | string;
  schedule_version: number;
  result_version: number;
  projection_version: number;
  generated_at: Date | string;
  source_updated_at: Date | string;
};

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Public projection contains an invalid timestamp");
  return parsed.toISOString();
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
  if (encoded === undefined) throw new Error("Public projection contains an unsupported value");
  return encoded;
}

function etag(input: {
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  payload: Record<string, unknown>;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      stableJson({
        competition_id: input.competitionId,
        schedule_version: input.scheduleVersion,
        result_version: input.resultVersion,
        projection_version: input.projectionVersion,
        projection: input.payload,
      }),
    )
    .digest("hex");
  return `c4-${input.scheduleVersion}-${input.resultVersion}-${input.projectionVersion}-${fingerprint}`;
}

export class GateCC4PublicTruthRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  async read(slug: string): Promise<{
    payload: Record<string, unknown>;
    freshness: PublicProjectionFreshness;
  } | null> {
    const row = (
      await this.sql.unsafe<PublicTruthRow>(
        `SELECT competition.id AS competition_id,
                current_projection.projection AS payload,
                publication.schedule_version,
                publication.result_version,
                COALESCE((
                  SELECT max(version.projection_version)
                  FROM public_projection_versions version
                  WHERE version.competition_id=competition.id
                    AND version.schedule_version=publication.schedule_version
                    AND version.result_version=publication.result_version
                ),1)::integer AS projection_version,
                current_projection.generated_at,
                publication.updated_at AS source_updated_at
         FROM competitions competition
         JOIN competition_publications publication
           ON publication.competition_id=competition.id
         JOIN public_competition_projections current_projection
           ON current_projection.competition_id=competition.id
          AND current_projection.schedule_version=publication.schedule_version
          AND current_projection.result_version=publication.result_version
         WHERE competition.slug=$1
           AND competition.status IN ('active','published','live','completed','archived')`,
        [slug],
      )
    )[0];
    if (!row) return null;

    const source = json(row.payload);
    assertPublicProjectionPrivacy(source);
    const generatedAt = instant(row.generated_at);
    const sourceUpdatedAt = instant(row.source_updated_at);
    const freshness: PublicProjectionFreshness = {
      division_id: row.competition_id,
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: row.projection_version,
      generated_at: generatedAt,
      source_updated_at: sourceUpdatedAt,
      etag: etag({
        competitionId: row.competition_id,
        scheduleVersion: row.schedule_version,
        resultVersion: row.result_version,
        projectionVersion: row.projection_version,
        payload: source,
      }),
    };
    const payload = {
      ...source,
      freshness,
      last_updated_at: sourceUpdatedAt,
    };
    assertPublicProjectionPrivacy(payload);
    return { payload, freshness };
  }
}

export async function registerGateCC4PublicTruthRoutes(
  app: FastifyInstance,
  runtime: GateCC4PublicTruthRuntime,
): Promise<void> {
  app.get<{ Params: { slug: string }; Headers: { "if-none-match"?: string; "if-modified-since"?: string } }>(
    "/api/v1/public/competitions/:slug/current",
    {
      schema: {
        description:
          "Read the exact current schedule/result projection with immutable C4 freshness and conditional-cache metadata.",
        params: strict({ slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }) }),
        headers: Type.Object(
          {
            "if-none-match": Type.Optional(Type.String({ maxLength: 1_000 })),
            "if-modified-since": Type.Optional(Type.String({ maxLength: 100 })),
          },
          { additionalProperties: true },
        ),
        response: { 200: Type.Unknown(), 304: Type.Null(), 404: Type.Unknown() },
        tags: ["public", "gate-c-c4"],
      },
    },
    async (request, reply) => {
      const result = await runtime.read(request.params.slug);
      if (!result) throw new ApiError(404, "PUBLIC_COMPETITION_NOT_FOUND", "Competition not found");
      const headers = gateCC4PublicHeaders(result.freshness);
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
      const status = gateCC4PublicConditionalStatus(result.freshness, {
        "if-none-match": request.headers["if-none-match"],
        "if-modified-since": request.headers["if-modified-since"],
      });
      if (status === 304) return reply.code(304).send();
      return result.payload;
    },
  );
}
