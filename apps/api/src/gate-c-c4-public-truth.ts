import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { buildGateCPublicHttpContract, gateCPublicConditionalStatus } from "./gate-c-public-http.js";

type PublicTruthRow = {
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
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json(value: PublicTruthRow["payload"]): Record<string, unknown> {
  return typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;
}

export class GateCC4PublicTruthRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  async read(slug: string): Promise<{
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  } | null> {
    const row = (
      await this.sql.unsafe<PublicTruthRow>(
        `SELECT projection.payload,publication.schedule_version,publication.result_version,
                projection.projection_version,projection.generated_at,projection.source_updated_at
         FROM competitions competition
         JOIN competition_publications publication ON publication.competition_id=competition.id
         JOIN LATERAL (
           SELECT payload,projection_version,generated_at,source_updated_at
           FROM public_projection_versions
           WHERE competition_id=competition.id
             AND schedule_version=publication.schedule_version
             AND result_version=publication.result_version
           ORDER BY projection_version DESC,division_id
           LIMIT 1
         ) projection ON true
         WHERE competition.slug=$1
           AND competition.status IN ('active','completed','archived')`,
        [slug],
      )
    )[0];
    if (!row) return null;
    const freshness = {
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: row.projection_version,
      generated_at: instant(row.generated_at),
      source_updated_at: instant(row.source_updated_at),
    };
    const source = json(row.payload);
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
    const contract = buildGateCPublicHttpContract({
      competitionId:
        payload.competition && typeof payload.competition === "object" && !Array.isArray(payload.competition)
          ? String((payload.competition as Record<string, unknown>).id ?? "")
          : "",
      scheduleVersion: row.schedule_version,
      resultVersion: row.result_version,
      projectionVersion: row.projection_version,
      generatedAt: freshness.generated_at,
      sourceUpdatedAt: freshness.source_updated_at,
    });
    return { payload, headers: contract.headers };
  }
}

export async function registerGateCC4PublicTruthRoutes(
  app: FastifyInstance,
  runtime: GateCC4PublicTruthRuntime,
) {
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
        response: { 200: Type.Unknown(), 304: Type.Null(), 404: Type.Unknown() },
        tags: ["public", "gate-c-c4"],
      },
    },
    async (request, reply) => {
      const result = await runtime.read(request.params.slug);
      if (!result) {
        return reply.code(404).send({ error: { code: "PUBLIC_COMPETITION_NOT_FOUND", message: "Competition not found" } });
      }
      for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
      const status = gateCPublicConditionalStatus(
        { ifNoneMatch: request.headers["if-none-match"], ifModifiedSince: request.headers["if-modified-since"] },
        result.headers,
      );
      if (status === 304) return reply.code(304).send();
      return result.payload;
    },
  );
}
