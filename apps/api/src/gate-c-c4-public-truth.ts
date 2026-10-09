import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { PublicCompetitionSummary, PublicProjectionFreshness } from "@matchday/contracts";
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

function liveRevision(value: number | null | undefined): number {
  if (value === null || value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Public projection contains an invalid live revision");
  return value;
}

/**
 * Opaque public version token streamed to spectators. Schedule and result
 * versions only move on publication; live_revision moves on every content
 * change of the current projection row (each scored point), so the token
 * changes monotonically with everything a spectator can see.
 */
export function publicProjectionVersionToken(input: {
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  liveRevision: number;
}): string {
  return `${input.scheduleVersion}:${input.resultVersion}:${input.projectionVersion}:${input.liveRevision}`;
}

function etag(input: {
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  liveRevision: number;
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
        live_revision: input.liveRevision,
        division_projection_versions: input.divisionProjectionVersions,
        projection: input.payload,
      }),
    )
    .digest("hex");
  return `c4-${input.scheduleVersion}-${input.resultVersion}-${input.projectionVersion}-${input.liveRevision}-${fingerprint}`;
}

export class GateCC4PublicTruthRuntime {
  private readonly publicProjectionRepo: PublicProjectionRepository;

  constructor(
    private readonly sql: PostgresJsSql,
    publicProjectionRepo?: PublicProjectionRepository,
  ) {
    this.publicProjectionRepo = publicProjectionRepo ?? new PublicProjectionRepository(sql);
  }

  async list(): Promise<PublicCompetitionSummary[]> {
    const rows = await this.sql.unsafe<{
      id: string;
      name: string;
      slug: string;
      sport_code: PublicCompetitionSummary["sport_code"];
      timezone: string;
      starts_on: Date | string;
      ends_on: Date | string;
      status: PublicCompetitionSummary["status"];
    }>(
      `SELECT competition.id,competition.name,competition.slug,competition.sport_code,
              competition.timezone,competition.starts_on,competition.ends_on,competition.status
       FROM competitions competition
       JOIN competition_publications publication
         ON publication.competition_id=competition.id
       JOIN public_competition_projections current_projection
         ON current_projection.competition_id=competition.id
        AND current_projection.schedule_version=publication.schedule_version
        AND current_projection.result_version=publication.result_version
       WHERE competition.status IN ('active', 'published', 'live', 'completed', 'archived')
         AND (publication.schedule_version > 0 OR publication.result_version > 0)
       ORDER BY competition.starts_on DESC,competition.name,competition.id`,
      [],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      sport_code: row.sport_code,
      timezone: row.timezone,
      starts_on: instant(row.starts_on).slice(0, 10),
      ends_on: instant(row.ends_on).slice(0, 10),
      status: row.status,
    }));
  }

  async version(slug: string): Promise<string | null> {
    const rows = await this.sql.unsafe<{
      schedule_version: number;
      result_version: number;
      projection_version: number;
      live_revision: number;
    }>(
      // One indexed primary-key lookup per poll: the live revision lives on the
      // projection row that is already joined, so live freshness adds no query.
      `SELECT publication.schedule_version, publication.result_version, projection.live_revision,
              COALESCE((SELECT max(version.projection_version)
                        FROM public_projection_versions version
                        WHERE version.competition_id=competition.id
                          AND version.schedule_version=publication.schedule_version
                          AND version.result_version=publication.result_version),1)::integer AS projection_version
       FROM competitions competition
       JOIN competition_publications publication ON publication.competition_id=competition.id
       JOIN public_competition_projections projection ON projection.competition_id=competition.id
         AND projection.schedule_version=publication.schedule_version
         AND projection.result_version=publication.result_version
       WHERE competition.slug=$1 AND competition.status IN ('active','published','live','completed','archived')`,
      [slug],
    );
    const current = rows[0];
    return current
      ? publicProjectionVersionToken({
          scheduleVersion: current.schedule_version,
          resultVersion: current.result_version,
          projectionVersion: current.projection_version,
          liveRevision: liveRevision(current.live_revision),
        })
      : null;
  }

  async read(
    slug: string,
    selectedDivisionId?: string,
  ): Promise<{
    payload: Record<string, unknown>;
    freshness: PublicProjectionFreshness;
    /** Same token as version(); lets the ETag and the SSE stream agree. */
    version: string;
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

    const currentLiveRevision = liveRevision(row.live_revision);
    const headerEtag = etag({
      competitionId: row.competition_id,
      scheduleVersion: row.schedule_version,
      resultVersion: row.result_version,
      projectionVersion,
      liveRevision: currentLiveRevision,
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
      version: publicProjectionVersionToken({
        scheduleVersion: row.schedule_version,
        resultVersion: row.result_version,
        projectionVersion: row.projection_version,
        liveRevision: currentLiveRevision,
      }),
    };
  }
}

type PublicTruthReadResult = Readonly<{
  payload: Record<string, unknown>;
  freshness: PublicProjectionFreshness;
  version?: string;
}>;

type PublicTruthRuntime = Pick<GateCC4PublicTruthRuntime, "list"> & {
  read(slug: string, selectedDivisionId?: string): Promise<PublicTruthReadResult | null>;
} & Partial<Pick<GateCC4PublicTruthRuntime, "version">>;

function streamVersion(result: PublicTruthReadResult | null): string | null {
  if (!result) return null;
  return (
    result.version ??
    `${result.freshness.schedule_version}:${result.freshness.result_version}:${result.freshness.projection_version}`
  );
}

export async function registerGateCC4PublicTruthRoutes(
  app: FastifyInstance,
  options: { runtime: PublicTruthRuntime } | PublicTruthRuntime,
): Promise<void> {
  const runtime = "runtime" in options ? options.runtime : options;

  app.get(
    "/api/v1/public/competitions",
    {
      schema: {
        description: "List competitions with an exact current public projection. No sign-in is required.",
        tags: ["public"],
        response: {
          200: strict({
            competitions: Type.Array(
              strict({
                id: Type.String({ format: "uuid" }),
                name: Type.String(),
                slug: Type.String({ minLength: 1, maxLength: 120 }),
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
                status: Type.Union([
                  Type.Literal("active"),
                  Type.Literal("published"),
                  Type.Literal("live"),
                  Type.Literal("completed"),
                  Type.Literal("archived"),
                ]),
              }),
            ),
          }),
        },
      },
    },
    async () => ({ competitions: await runtime.list() }),
  );

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

  // The event contains a version only. The browser must refetch /current to
  // display the privacy-checked, atomic public projection.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/public/competitions/:slug/versions",
    {
      schema: {
        tags: ["public"],
        params: strict({ slug: Type.String({ minLength: 1, maxLength: 100 }) }),
      },
    },
    async (request, reply) => {
      // The opening token uses the same cheap lookup as the poller instead of a
      // full projection read; a missing competition is still a 404.
      const first = runtime.version
        ? await runtime.version(request.params.slug)
        : streamVersion(await runtime.read(request.params.slug));
      if (!first) throw new ApiError(404, ErrorCode.PUBLIC_COMPETITION_NOT_FOUND, "Competition not found");
      let lastVersion = first;
      let checking = false;
      let finished = false;
      const stream = new Readable({ read() {} });
      const sendVersion = (version: string) => stream.push(`event: version\ndata: ${JSON.stringify(version)}\n\n`);
      sendVersion(lastVersion);
      const timer = setInterval(async () => {
        if (checking || finished || stream.destroyed) return;
        checking = true;
        try {
          const currentVersion = runtime.version
            ? await runtime.version(request.params.slug)
            : streamVersion(await runtime.read(request.params.slug));
          if (finished || stream.destroyed) return;
          if (!currentVersion) {
            stream.push("event: unavailable\ndata: {}\n\n");
            finish();
          } else if (currentVersion !== lastVersion) {
            lastVersion = currentVersion;
            sendVersion(lastVersion);
          } else {
            stream.push("event: heartbeat\ndata: {}\n\n");
          }
        } catch {
          if (finished || stream.destroyed) return;
          stream.push("event: reconnect\ndata: {}\n\n");
          finish();
        } finally {
          checking = false;
        }
      }, 2_000);
      const lifetime = setTimeout(finish, 28_000);
      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        clearTimeout(lifetime);
        stream.push(null);
      }
      stream.on("close", () => {
        finished = true;
        clearInterval(timer);
        clearTimeout(lifetime);
      });
      reply.header("Content-Type", "text/event-stream; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      reply.header("X-Accel-Buffering", "no");
      return reply.send(stream);
    },
  );
}
