import { createHash } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { PublicProjectionFreshness } from "@matchday/contracts";
import { assertPublicProjectionPrivacy } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import { gateCC4PublicTruthResponse } from "./gate-c-c4-schemas.js";
import { gateCC4PublicConditionalStatus, gateCC4PublicHeaders } from "./gate-c-public-http.js";
import { PublicProjectionRepository, type PublicTruthRecord } from "./repositories/index.js";

type PublicTruthRow = PublicTruthRecord;

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const ErrorResponse = strict({
  error: strict({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Public projection contains an invalid timestamp");
  return parsed.toISOString();
}

function json(value: PublicTruthRow["payload"]): Record<string, unknown> {
  return typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;
}

function divisionId(payload: Record<string, unknown>): string {
  const division = payload.division;
  if (!division || typeof division !== "object" || Array.isArray(division)) {
    throw new Error("Public projection contains no canonical division identifier");
  }
  const id = (division as Record<string, unknown>).id;
  if (typeof id !== "string") throw new Error("Public projection contains no canonical division identifier");
  return id;
}

function divisionIds(payload: Record<string, unknown>): readonly string[] {
  const divisions = payload.divisions;
  if (!Array.isArray(divisions) || divisions.length === 0) {
    throw new Error("Public projection contains no division packages");
  }
  const ids = divisions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Public projection contains an invalid division package");
    }
    return divisionId(entry as Record<string, unknown>);
  });
  if (new Set(ids).size !== ids.length) throw new Error("Public projection contains duplicate division packages");
  return ids.sort((left, right) => left.localeCompare(right));
}

function divisionScopedPayload(
  payload: Record<string, unknown>,
  selectedDivisionId?: string,
): Record<string, unknown> | null {
  if (!selectedDivisionId) return payload;
  const divisions = payload.divisions;
  if (!Array.isArray(divisions)) throw new Error("Public projection contains no division packages");
  const selected = divisions.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      divisionId(entry as Record<string, unknown>) === selectedDivisionId,
  ) as Record<string, unknown> | undefined;
  if (!selected) return null;
  const division = selected.division;
  if (!division || typeof division !== "object" || Array.isArray(division)) {
    throw new Error("Public projection contains an invalid division package");
  }
  const selectedPackage = structuredClone(selected);
  const legacyPackage = structuredClone(selected);
  return {
    ...payload,
    divisions: [selectedPackage],
    division: legacyPackage.division,
    schedule: legacyPackage.schedule,
    results: legacyPackage.results,
    standings: legacyPackage.standings,
    bracket: legacyPackage.bracket,
  };
}

function versionRecord(value: PublicTruthRow["division_projection_versions"]): Record<string, number> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Public projection contains malformed division freshness metadata");
  }
  const versions = Object.fromEntries(
    Object.entries(parsed).map(([id, version]) => {
      if (!Number.isSafeInteger(version) || (version as number) < 1) {
        throw new Error("Public projection contains an invalid division projection version");
      }
      return [id, version as number];
    }),
  );
  return versions;
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
  divisionProjectionVersions: Readonly<Record<string, number>>;
  payload: Record<string, unknown>;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      stableJson({
        competition_id: input.competitionId,
        schedule_version: input.scheduleVersion,
        result_version: input.resultVersion,
        projection_version: input.projectionVersion,
        division_projection_versions: input.divisionProjectionVersions,
        projection: input.payload,
      }),
    )
    .digest("hex");
  return `c4-${input.scheduleVersion}-${input.resultVersion}-${input.projectionVersion}-${fingerprint}`;
}

export class GateCC4PublicTruthRuntime {
  private readonly publicProjectionRepo: PublicProjectionRepository;

  constructor(
    private readonly sql: PostgresJsSql,
    publicProjectionRepo?: PublicProjectionRepository,
  ) {
    this.publicProjectionRepo = publicProjectionRepo ?? new PublicProjectionRepository(sql);
  }

  async read(
    slug: string,
    selectedDivisionId?: string,
  ): Promise<{
    payload: Record<string, unknown>;
    freshness: PublicProjectionFreshness;
  } | null> {
    const row = await this.publicProjectionRepo.findPublicTruth(slug, this.sql);
    if (!row) return null;

    const fullPayload = json(row.payload);
    assertPublicProjectionPrivacy(fullPayload);
    const availableDivisions = divisionIds(fullPayload);
    if (selectedDivisionId && !availableDivisions.includes(selectedDivisionId)) {
      return null;
    }
    const responsePayload = divisionScopedPayload(fullPayload, selectedDivisionId);
    if (!responsePayload) return null;
    const divisionVersions = versionRecord(row.division_projection_versions);
    for (const div of Object.keys(divisionVersions)) {
      if (!availableDivisions.includes(div)) {
        throw new Error("Public projection freshness metadata references a division outside its payload");
      }
    }
    for (const division of availableDivisions) {
      if (!divisionVersions[division]) {
        divisionVersions[division] = row.projection_version || 1;
      }
    }
    const filteredDivisionVersions = selectedDivisionId
      ? { [selectedDivisionId]: divisionVersions[selectedDivisionId]! }
      : divisionVersions;
    const effectiveDivisionId =
      selectedDivisionId ??
      ((responsePayload.division as Record<string, unknown> | undefined)?.id as string | undefined) ??
      divisionIds(fullPayload)[0]!;
    const projectionVersion = selectedDivisionId
      ? (filteredDivisionVersions[selectedDivisionId] ?? row.projection_version)
      : row.projection_version;

    const headerEtag = etag({
      competitionId: row.competition_id,
      scheduleVersion: row.schedule_version,
      resultVersion: row.result_version,
      projectionVersion,
      divisionProjectionVersions: filteredDivisionVersions,
      payload: responsePayload,
    });
    const generatedDate = new Date(row.generated_at);
    const sourceUpdatedDate = new Date(row.source_updated_at);
    const effectiveGeneratedAt =
      generatedDate.getTime() < sourceUpdatedDate.getTime()
        ? sourceUpdatedDate.toISOString()
        : instant(row.generated_at);
    const freshness: PublicProjectionFreshness = {
      division_id: effectiveDivisionId,
      division_projection_versions: filteredDivisionVersions,
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: projectionVersion,
      etag: headerEtag,
      generated_at: effectiveGeneratedAt,
      source_updated_at: instant(row.source_updated_at),
    };
    const enrichedPayload = {
      ...responsePayload,
      publication: {
        schedule_version: row.schedule_version,
        result_version: row.result_version,
      },
      freshness,
      last_updated_at: instant(row.source_updated_at),
    };
    return {
      payload: enrichedPayload,
      freshness,
    };
  }
}

export async function registerGateCC4PublicTruthRoutes(
  app: FastifyInstance,
  options: { runtime: Pick<GateCC4PublicTruthRuntime, "read"> } | Pick<GateCC4PublicTruthRuntime, "read">,
): Promise<void> {
  const runtime = "runtime" in options ? options.runtime : options;
  const handler = async (
    request: {
      params: { slug: string };
      query: { division_id?: string; division?: string };
      headers: { "if-none-match"?: string; "if-modified-since"?: string };
    },
    reply: {
      header: (key: string, value: string) => void;
      code: (statusCode: number) => { send: (body?: unknown) => unknown };
    },
  ) => {
    const selectedDivision = request.query.division_id ?? request.query.division;
    const result = await runtime.read(request.params.slug, selectedDivision);
    if (!result) throw new ApiError(404, ErrorCode.PUBLIC_COMPETITION_NOT_FOUND, "Competition not found");
    const headers = gateCC4PublicHeaders(result.freshness);
    for (const [key, value] of Object.entries(headers)) reply.header(key, value);
    const status = gateCC4PublicConditionalStatus(result.freshness, request.headers);
    if (status === 304) return reply.code(304).send();
    return reply.code(200).send(result.payload);
  };

  const schema = {
    description: "Public competition read; version-matched truth across results, schedules, and standings.",
    tags: ["public"],
    params: strict({ slug: Type.String({ minLength: 1, maxLength: 100 }) }),
    querystring: Type.Object(
      {
        division_id: Type.Optional(Type.String({ format: "uuid" })),
        division: Type.Optional(Type.String({ format: "uuid" })),
      },
      { additionalProperties: true },
    ),
    headers: Type.Object(
      {
        "if-none-match": Type.Optional(Type.String()),
        "if-modified-since": Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    response: { 200: gateCC4PublicTruthResponse, 304: Type.Null(), 404: ErrorResponse },
  };

  app.get<{
    Params: { slug: string };
    Querystring: { division_id?: string; division?: string };
    Headers: { "if-none-match"?: string; "if-modified-since"?: string };
  }>("/api/v1/public/competitions/:slug/current", { schema }, handler as never);
}
