/**
 * Live score overlay for public competition projections.
 *
 * A scored point upserts one public_live_match_scores row for its match
 * instead of rebuilding the competition projection. Readers overlay the
 * visible rows (match still in progress, updated after the projection's stale
 * cut-off) onto the last full projection. The SQL fragments below are shared
 * by every reader so the public version token, the ETag and the payload are
 * always derived from the same row set.
 */

export type LiveOverlayEntry = Readonly<{
  match_id: string;
  division_id: string;
  revision: number | string;
  updated_at: string;
  result: Record<string, unknown>;
}>;

/**
 * Visible overlay rows for `competition`, joined against `publication` and
 * `projection` aliases of the current public projection.
 */
function visibleOverlay(competition: string, publication: string, projection: string): string {
  return `FROM public_live_match_scores live
          JOIN matches live_match ON live_match.id=live.match_id AND live_match.state='in_progress'
          WHERE live.competition_id=${competition}
            AND ${publication}.schedule_version > 0
            AND (${projection}.live_overlay_cutoff_at IS NULL OR live.updated_at > ${projection}.live_overlay_cutoff_at)`;
}

/** Digest of (match_id, revision) of the visible rows; NULL when nothing is overlaid. */
export function liveOverlayDigestSql(competition: string, publication: string, projection: string): string {
  return `(SELECT md5(string_agg(live.match_id::text || ':' || live.revision::text, ',' ORDER BY live.match_id))
          ${visibleOverlay(competition, publication, projection)})`;
}

/** The visible rows as a JSON array ordered by match. */
export function liveOverlayRowsSql(competition: string, publication: string, projection: string): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'match_id', live.match_id,
              'division_id', live.division_id,
              'revision', live.revision,
              'updated_at', live.updated_at,
              'result', live.live_result) ORDER BY live.match_id)
          ${visibleOverlay(competition, publication, projection)}), '[]'::jsonb)`;
}

export function parseLiveOverlay(value: unknown): LiveOverlayEntry[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error("Public live overlay is malformed");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Public live overlay is malformed");
    const row = entry as Record<string, unknown>;
    const result = row.result;
    if (
      typeof row.match_id !== "string" ||
      typeof row.division_id !== "string" ||
      typeof row.updated_at !== "string" ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (result as Record<string, unknown>).id !== row.match_id
    ) {
      throw new Error("Public live overlay is malformed");
    }
    return {
      match_id: row.match_id,
      division_id: row.division_id,
      revision: row.revision as number | string,
      updated_at: new Date(row.updated_at).toISOString(),
      result: result as Record<string, unknown>,
    };
  });
}

/** Public version suffix: changes whenever any visible overlay row is written or the visible set changes. */
export function liveOverlayToken(digest: string | null | undefined): string {
  if (digest === null || digest === undefined) return "";
  if (!/^[0-9a-f]{32}$/u.test(digest)) throw new Error("Public live overlay digest is invalid");
  return `.${digest.slice(0, 16)}`;
}

/** Latest overlay write time, or null when nothing is overlaid. */
export function liveOverlayUpdatedAt(entries: readonly LiveOverlayEntry[]): string | null {
  let latest: number | null = null;
  for (const entry of entries) {
    const time = Date.parse(entry.updated_at);
    if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

type DivisionPackage = Record<string, unknown> & { division?: unknown; results?: unknown };

function packageDivisionId(entry: DivisionPackage): string | undefined {
  const division = entry.division;
  if (!division || typeof division !== "object" || Array.isArray(division)) return undefined;
  const id = (division as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Returns the projection with live entries replacing (or adding to) each
 * division's results. Never mutates its inputs; unchanged division packages
 * are shared by reference. Live entries follow the persisted results ordered
 * by match id, as the full projection writer orders them.
 */
export function applyLiveOverlay<T extends Record<string, unknown>>(
  payload: T,
  entries: readonly LiveOverlayEntry[],
): T {
  if (entries.length === 0) return payload;
  const divisions = payload.divisions;
  if (!Array.isArray(divisions)) return payload;
  const overlaid = new Set(entries.map((entry) => entry.match_id));
  const byDivision = new Map<string, LiveOverlayEntry[]>();
  for (const entry of [...entries].sort((left, right) => left.match_id.localeCompare(right.match_id))) {
    byDivision.set(entry.division_id, [...(byDivision.get(entry.division_id) ?? []), entry]);
  }
  const nextDivisions = (divisions as DivisionPackage[]).map((entry) => {
    const id = packageDivisionId(entry);
    const live = id ? (byDivision.get(id) ?? []) : [];
    const results = Array.isArray(entry.results) ? (entry.results as Array<Record<string, unknown>>) : [];
    const touched = live.length > 0 || results.some((result) => overlaid.has(String(result?.id)));
    if (!touched) return entry;
    return {
      ...entry,
      results: [...results.filter((result) => !overlaid.has(String(result?.id))), ...live.map((row) => row.result)],
    };
  });
  const legacyId =
    payload.division && typeof payload.division === "object"
      ? ((payload.division as Record<string, unknown>).id as string | undefined)
      : undefined;
  const legacy = nextDivisions.find((entry) => packageDivisionId(entry) === legacyId);
  return {
    ...payload,
    divisions: nextDivisions,
    ...(legacy && "results" in payload ? { results: legacy.results } : {}),
  };
}
