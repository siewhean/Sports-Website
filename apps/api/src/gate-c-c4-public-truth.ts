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
import {
  applyLiveOverlay,
  liveOverlayDigestSql,
  liveOverlayToken,
  liveOverlayUpdatedAt,
  parseLiveOverlay,
} from "./public-live-overlay.js";
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

function json(value: Record<string, unknown> | string): Record<string, unknown> {
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

/**
 * Narrows the payload to one division. Nothing downstream mutates the result,
 * so the selected package is shared rather than deep-cloned per request.
 */
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
  return {
    ...payload,
    divisions: [selected],
    division: selected.division,
    schedule: selected.schedule,
    results: selected.results,
    standings: selected.standings,
    bracket: selected.bracket,
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
 * change of the stored projection row; the optional overlay suffix moves on
 * every scored point (it digests the visible live score rows). The token
 * therefore changes with everything a spectator can see.
 */
export function publicProjectionVersionToken(input: {
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  liveRevision: number;
  liveOverlayDigest?: string | null;
}): string {
  return `${input.scheduleVersion}:${input.resultVersion}:${input.projectionVersion}:${input.liveRevision}${liveOverlayToken(
    input.liveOverlayDigest,
  )}`;
}

/**
 * Content-addressed ETag computed from the inputs that fully determine the
 * response body (stored projection digest, overlay digest, versions, division
 * selection), so it is identical on every API instance without hashing the
 * payload per request.
 */
function etag(input: {
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  liveToken: string;
  divisionProjectionVersions: Readonly<Record<string, number>>;
  selectedDivisionId: string | null;
  projectionDigest: string;
  liveOverlayDigest: string | null;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      stableJson({
        competition_id: input.competitionId,
        schedule_version: input.scheduleVersion,
        result_version: input.resultVersion,
        projection_version: input.projectionVersion,
        live_revision: input.liveToken,
        division_projection_versions: input.divisionProjectionVersions,
        division: input.selectedDivisionId,
        projection_digest: input.projectionDigest,
        live_overlay_digest: input.liveOverlayDigest,
      }),
    )
    .digest("hex");
  return `c4-${input.scheduleVersion}-${input.resultVersion}-${input.projectionVersion}-${input.liveToken}-${fingerprint}`;
}

export type PublicTruthReadResult = Readonly<{
  payload: Record<string, unknown>;
  freshness: PublicProjectionFreshness;
  /** Same token as version(); lets the ETag and the SSE stream agree. */
  version?: string;
}>;

type CachedBase = Readonly<{
  key: string;
  payload: Record<string, unknown>;
  divisionIds: readonly string[];
  digest: string;
}>;

const publicTruthCacheLimit = 256;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > publicTruthCacheLimit) cache.delete(cache.keys().next().value as string);
}

const defaultListPageSize = 50;
const maximumListPageSize = 200;

type ListCursor = Readonly<{ startsOn: string; name: string; id: string }>;

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.startsOn, cursor.name, cursor.id]), "utf8").toString("base64url");
}

function decodeListCursor(value: string): ListCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(decoded) &&
      decoded.length === 3 &&
      typeof decoded[0] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(decoded[0]) &&
      typeof decoded[1] === "string" &&
      typeof decoded[2] === "string" &&
      /^[0-9a-f-]{36}$/iu.test(decoded[2])
    ) {
      return { startsOn: decoded[0], name: decoded[1], id: decoded[2] };
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, ErrorCode.VALIDATION_ERROR, "Invalid competition listing cursor");
}

export type PublicCompetitionPage = Readonly<{
  competitions: PublicCompetitionSummary[];
  next_cursor: string | null;
}>;

export class GateCC4PublicTruthRuntime {
  private readonly publicProjectionRepo: PublicProjectionRepository;
  /** Parsed, privacy-checked stored projection per slug (one per current base). */
  private readonly bases = new Map<string, CachedBase>();
  /** Fully composed response per slug+division, valid while its key matches. */
  private readonly responses = new Map<string, { key: string; result: PublicTruthReadResult }>();

  constructor(
    private readonly sql: PostgresJsSql,
    publicProjectionRepo?: PublicProjectionRepository,
  ) {
    this.publicProjectionRepo = publicProjectionRepo ?? new PublicProjectionRepository(sql);
  }

  /** Every listed competition (unpaginated; kept for internal callers). */
  async list(): Promise<PublicCompetitionSummary[]> {
    return (await this.listRows(null, null)).map((row) => this.summary(row));
  }

  /** Keyset-paginated listing, newest first; next_cursor is null on the last page. */
  async listPage(options: { limit?: number; cursor?: string } = {}): Promise<PublicCompetitionPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? defaultListPageSize), 1), maximumListPageSize);
    const cursor = options.cursor ? decodeListCursor(options.cursor) : null;
    const rows = await this.listRows(cursor, limit + 1);
    const page = rows.slice(0, limit).map((row) => this.summary(row));
    const last = page.at(-1);
    return {
      competitions: page,
      next_cursor:
        rows.length > limit && last
          ? encodeListCursor({ startsOn: last.starts_on, name: last.name, id: last.id })
          : null,
    };
  }

  private summary(row: {
    id: string;
    name: string;
    slug: string;
    sport_code: PublicCompetitionSummary["sport_code"];
    timezone: string;
    starts_on: Date | string;
    ends_on: Date | string;
    status: PublicCompetitionSummary["status"];
  }): PublicCompetitionSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      sport_code: row.sport_code,
      timezone: row.timezone,
      starts_on: instant(row.starts_on).slice(0, 10),
      ends_on: instant(row.ends_on).slice(0, 10),
      status: row.status,
    };
  }

  private listRows(cursor: ListCursor | null, limit: number | null) {
    return this.sql.unsafe<{
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
         AND ($1::date IS NULL
              OR competition.starts_on < $1::date
              OR (competition.starts_on = $1::date
                  AND (competition.name > $2::text OR (competition.name = $2::text AND competition.id > $3::uuid))))
       ORDER BY competition.starts_on DESC,competition.name,competition.id
       LIMIT $4`,
      [cursor?.startsOn ?? null, cursor?.name ?? null, cursor?.id ?? null, limit],
    );
  }

  async version(slug: string): Promise<string | null> {
    const rows = await this.sql.unsafe<{
      schedule_version: number;
      result_version: number;
      projection_version: number;
      live_revision: number;
      live_overlay_digest?: string | null;
    }>(
      // One indexed lookup per poll: the live revision lives on the projection
      // row that is already joined, and the overlay digest reads only the
      // competition's live score rows (index on competition_id).
      `SELECT publication.schedule_version, publication.result_version, projection.live_revision,
              COALESCE((SELECT max(version.projection_version)
                        FROM public_projection_versions version
                        WHERE version.competition_id=competition.id
                          AND version.schedule_version=publication.schedule_version
                          AND version.result_version=publication.result_version),1)::integer AS projection_version,
              ${liveOverlayDigestSql("competition.id", "publication", "projection")} AS live_overlay_digest
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
          liveOverlayDigest: current.live_overlay_digest ?? null,
        })
      : null;
  }

  async read(slug: string, selectedDivisionId?: string): Promise<PublicTruthReadResult | null> {
    const cachedBase = this.bases.get(slug);
    const row = await this.publicProjectionRepo.findPublicTruth(slug, this.sql, cachedBase?.key ?? null);
    if (!row) {
      this.bases.delete(slug);
      return null;
    }

    const responseKey = row.base_key
      ? [
          row.base_key,
          row.live_overlay_digest ?? "",
          row.projection_version,
          JSON.stringify(row.division_projection_versions),
          instant(row.generated_at),
          instant(row.source_updated_at),
        ].join("|")
      : null;
    const responseCacheKey = `${slug}\u0000${selectedDivisionId ?? ""}`;
    const cachedResponse = this.responses.get(responseCacheKey);
    if (responseKey && cachedResponse?.key === responseKey && (row.payload === null || row.payload === undefined)) {
      return cachedResponse.result;
    }

    let base: CachedBase;
    if (row.payload === null || row.payload === undefined) {
      if (!cachedBase || cachedBase.key !== row.base_key) throw new Error("Public projection payload is missing");
      base = cachedBase;
    } else {
      const fullPayload = json(row.payload);
      // Privacy validation and parsing run once per stored projection, not per request.
      assertPublicProjectionPrivacy(fullPayload);
      base = {
        key: row.base_key ?? "",
        payload: fullPayload,
        divisionIds: divisionIds(fullPayload),
        digest: row.projection_digest ?? createHash("sha256").update(stableJson(fullPayload)).digest("hex"),
      };
      if (row.base_key) remember(this.bases, slug, base);
    }

    const overlay = parseLiveOverlay(row.live_overlay);
    for (const entry of overlay) assertPublicProjectionPrivacy(entry.result);
    const liveOverlayDigest = row.live_overlay_digest ?? null;
    const availableDivisions = base.divisionIds;
    if (selectedDivisionId && !availableDivisions.includes(selectedDivisionId)) {
      return null;
    }
    const responsePayload = divisionScopedPayload(applyLiveOverlay(base.payload, overlay), selectedDivisionId);
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
      availableDivisions[0]!;
    const projectionVersion = selectedDivisionId
      ? (filteredDivisionVersions[selectedDivisionId] ?? row.projection_version)
      : row.projection_version;

    const currentLiveRevision = liveRevision(row.live_revision);
    const liveToken = `${currentLiveRevision}${liveOverlayToken(liveOverlayDigest)}`;
    const headerEtag = etag({
      competitionId: row.competition_id,
      scheduleVersion: row.schedule_version,
      resultVersion: row.result_version,
      projectionVersion,
      liveToken,
      divisionProjectionVersions: filteredDivisionVersions,
      selectedDivisionId: selectedDivisionId ?? null,
      projectionDigest: base.digest,
      liveOverlayDigest,
    });
    // A live point advances the public source time without touching the
    // publication row (which would serialise every court of the competition).
    const liveUpdatedAt = liveOverlayUpdatedAt(overlay);
    const publicationUpdatedAt = instant(row.source_updated_at);
    const sourceUpdatedAt =
      liveUpdatedAt && liveUpdatedAt > publicationUpdatedAt ? liveUpdatedAt : publicationUpdatedAt;
    const generatedAt = instant(row.generated_at);
    const effectiveGeneratedAt = generatedAt < sourceUpdatedAt ? sourceUpdatedAt : generatedAt;
    const freshness: PublicProjectionFreshness = {
      division_id: effectiveDivisionId,
      division_projection_versions: filteredDivisionVersions,
      schedule_version: row.schedule_version,
      result_version: row.result_version,
      projection_version: projectionVersion,
      etag: headerEtag,
      generated_at: effectiveGeneratedAt,
      source_updated_at: sourceUpdatedAt,
    };
    const enrichedPayload = {
      ...responsePayload,
      publication: {
        schedule_version: row.schedule_version,
        result_version: row.result_version,
      },
      freshness,
      last_updated_at: sourceUpdatedAt,
    };
    const result: PublicTruthReadResult = {
      payload: enrichedPayload,
      freshness,
      version: publicProjectionVersionToken({
        scheduleVersion: row.schedule_version,
        resultVersion: row.result_version,
        projectionVersion: row.projection_version,
        liveRevision: currentLiveRevision,
        liveOverlayDigest,
      }),
    };
    if (responseKey) remember(this.responses, responseCacheKey, { key: responseKey, result });
    return result;
  }
}

type PublicTruthRuntime = Pick<GateCC4PublicTruthRuntime, "list"> & {
  read(slug: string, selectedDivisionId?: string): Promise<PublicTruthReadResult | null>;
} & Partial<Pick<GateCC4PublicTruthRuntime, "version" | "listPage">>;

function streamVersion(result: PublicTruthReadResult | null): string | null {
  if (!result) return null;
  return (
    result.version ??
    `${result.freshness.schedule_version}:${result.freshness.result_version}:${result.freshness.projection_version}`
  );
}

const maximumIdleVersionChannels = 1_024;

type VersionEvent = Readonly<{ type: "version"; version: string | null }> | Readonly<{ type: "error" }>;
type VersionListener = (event: VersionEvent) => void;

/**
 * One version poller per slug per API instance, fanned out to every SSE
 * subscriber of that slug. N spectators cost one lookup per interval instead
 * of N; each subscriber still receives exactly one frame per interval
 * (version or heartbeat), so the wire protocol is unchanged.
 */
export class PublicVersionHub {
  private readonly channels = new Map<
    string,
    {
      listeners: Set<VersionListener>;
      timer: NodeJS.Timeout | null;
      checking: boolean;
      latest: { version: string | null; at: number } | null;
      opening: Promise<string | null> | null;
    }
  >();

  constructor(
    private readonly lookup: (slug: string) => Promise<string | null>,
    private readonly intervalMs = 2_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private channel(slug: string) {
    let channel = this.channels.get(slug);
    if (!channel) {
      channel = { listeners: new Set(), timer: null, checking: false, latest: null, opening: null };
      this.channels.set(slug, channel);
    }
    return channel;
  }

  /**
   * Opening token for a new subscriber: reuses the poller's last observation
   * when it is younger than one interval, and coalesces concurrent lookups, so
   * a reconnect wave does not become a query wave.
   */
  async current(slug: string): Promise<string | null> {
    const channel = this.channels.get(slug);
    if (channel?.latest && this.now() - channel.latest.at < this.intervalMs) return channel.latest.version;
    const target = this.channel(slug);
    if (!target.opening) {
      target.opening = this.lookup(slug)
        .then((version) => {
          target.latest = { version, at: this.now() };
          return version;
        })
        .finally(() => {
          target.opening = null;
          // Unknown slugs must not accumulate idle channels.
          if (target.latest?.version === null && target.listeners.size === 0) this.release(slug, target);
          this.evictIdle();
        });
    }
    return target.opening;
  }

  subscribe(slug: string, listener: VersionListener): () => void {
    const channel = this.channel(slug);
    channel.listeners.add(listener);
    channel.timer ??= setInterval(() => void this.poll(slug), this.intervalMs);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      channel.listeners.delete(listener);
      if (channel.listeners.size === 0) this.release(slug, channel);
    };
  }

  /** Stops an idle channel's poller and forgets it (only if it is still the registered one). */
  private release(slug: string, channel: NonNullable<ReturnType<PublicVersionHub["channels"]["get"]>>): void {
    if (channel.timer) clearInterval(channel.timer);
    channel.timer = null;
    if (this.channels.get(slug) === channel && !channel.opening) this.channels.delete(slug);
  }

  /** Bounds memory held for slugs that were looked up but have no subscribers. */
  private evictIdle(): void {
    if (this.channels.size <= maximumIdleVersionChannels) return;
    for (const [slug, channel] of this.channels) {
      if (this.channels.size <= maximumIdleVersionChannels) break;
      if (channel.listeners.size === 0 && !channel.opening) this.release(slug, channel);
    }
  }

  private async poll(slug: string): Promise<void> {
    const channel = this.channels.get(slug);
    if (!channel || channel.checking || channel.listeners.size === 0) return;
    channel.checking = true;
    let event: VersionEvent;
    try {
      const version = await this.lookup(slug);
      channel.latest = { version, at: this.now() };
      event = { type: "version", version };
    } catch {
      channel.latest = null;
      event = { type: "error" };
    } finally {
      channel.checking = false;
    }
    for (const listener of [...channel.listeners]) listener(event);
  }

  close(): void {
    for (const channel of this.channels.values()) {
      if (channel.timer) clearInterval(channel.timer);
      channel.timer = null;
      channel.listeners.clear();
    }
    this.channels.clear();
  }
}

export async function registerGateCC4PublicTruthRoutes(
  app: FastifyInstance,
  options: { runtime: PublicTruthRuntime } | PublicTruthRuntime,
): Promise<void> {
  const runtime = "runtime" in options ? options.runtime : options;
  const lookupVersion = (slug: string) =>
    runtime.version ? runtime.version(slug) : runtime.read(slug).then(streamVersion);
  const versionHub = new PublicVersionHub(lookupVersion);
  if (typeof app.addHook === "function") app.addHook("onClose", async () => versionHub.close());
  // Serialized response bodies, reused while the runtime returns the same
  // cached read result (i.e. until the public version changes).
  const serializedBodies = new WeakMap<object, string>();

  app.get(
    "/api/v1/public/competitions",
    {
      schema: {
        description:
          "List competitions with an exact current public projection, newest first. No sign-in is required. " +
          "Results are paginated (default 50); pass next_cursor back as cursor for the next page.",
        tags: ["public"],
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumListPageSize })),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          },
          { additionalProperties: true },
        ),
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
            next_cursor: Type.Optional(Type.String()),
          }),
          400: ErrorResponse,
        },
      },
    },
    async (request) => {
      const query = (request.query ?? {}) as { limit?: number; cursor?: string };
      if (!runtime.listPage) return { competitions: await runtime.list() };
      const page = await runtime.listPage({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return { competitions: page.competitions, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
    },
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
      getSerializationFunction?: (httpStatus: string) => ((payload: Record<string, unknown>) => string) | undefined;
    },
  ) => {
    const selectedDivision = request.query.division_id ?? request.query.division;
    const result = await runtime.read(request.params.slug, selectedDivision);
    if (!result) throw new ApiError(404, ErrorCode.PUBLIC_COMPETITION_NOT_FOUND, "Competition not found");
    const headers = gateCC4PublicHeaders(result.freshness);
    for (const [key, value] of Object.entries(headers)) reply.header(key, value);
    const status = gateCC4PublicConditionalStatus(result.freshness, request.headers);
    if (status === 304) return reply.code(304).send();
    const serialize = reply.getSerializationFunction?.("200");
    if (!serialize) return reply.code(200).send(result.payload);
    // The route's own response-schema serializer runs once per public version;
    // later requests for the same version send the stored bytes.
    let body = serializedBodies.get(result);
    if (body === undefined) {
      body = serialize(result.payload);
      serializedBodies.set(result, body);
    }
    reply.header("content-type", "application/json; charset=utf-8");
    return reply.code(200).send(body);
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
      const slug = request.params.slug;
      // The opening token reuses the shared poller's latest observation when fresh;
      // a missing competition is still a 404.
      const first = await versionHub.current(slug);
      if (!first) throw new ApiError(404, ErrorCode.PUBLIC_COMPETITION_NOT_FOUND, "Competition not found");
      let lastVersion = first;
      let finished = false;
      const stream = new Readable({ read() {} });
      const sendVersion = (version: string) => stream.push(`event: version\ndata: ${JSON.stringify(version)}\n\n`);
      sendVersion(lastVersion);
      const unsubscribe = versionHub.subscribe(slug, (event) => {
        if (finished || stream.destroyed) return;
        if (event.type === "error") {
          stream.push("event: reconnect\ndata: {}\n\n");
          finish();
        } else if (!event.version) {
          stream.push("event: unavailable\ndata: {}\n\n");
          finish();
        } else if (event.version !== lastVersion) {
          lastVersion = event.version;
          sendVersion(lastVersion);
        } else {
          stream.push("event: heartbeat\ndata: {}\n\n");
        }
      });
      const lifetime = setTimeout(finish, 28_000);
      function finish() {
        if (finished) return;
        finished = true;
        unsubscribe();
        clearTimeout(lifetime);
        stream.push(null);
      }
      stream.on("close", () => {
        finished = true;
        unsubscribe();
        clearTimeout(lifetime);
      });
      reply.header("Content-Type", "text/event-stream; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      reply.header("X-Accel-Buffering", "no");
      return reply.send(stream);
    },
  );
}
