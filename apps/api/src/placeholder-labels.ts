// One loader for placeholder labels so the organiser workspace, the entries list and the public
// projection can never disagree about the label for the same entry. Group letters and positions
// come from each division's published format graph (never from row-id ordering), see
// resolvePlaceholderLabels in @matchday/domain.

import {
  placeholderGroupsFromGraph,
  resolvePlaceholderLabels,
  type PlaceholderFormatGraph,
  type PlaceholderGroup,
  type ResolvedPlaceholderLabel,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";

function decoded<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

export type CompetitionPlaceholderLabels = Readonly<{
  labels: ReadonlyMap<string, ResolvedPlaceholderLabel>;
  /** Published-graph groups per division, in graph order (internal graph ids included). */
  groupsByDivision: ReadonlyMap<string, readonly PlaceholderGroup[]>;
  /** seed -> entry id per division, for mapping graph groups back to entries. */
  entryIdBySeed: ReadonlyMap<string, ReadonlyMap<number, string>>;
  multiDivision: boolean;
}>;

export async function loadCompetitionPlaceholderLabels(
  database: PostgresJsSql,
  competitionId: string,
): Promise<CompetitionPlaceholderLabels> {
  const divisions = await database.unsafe<{ id: string; short_code: string | null }>(
    `SELECT id,short_code FROM divisions WHERE competition_id=$1 ORDER BY created_at,id`,
    [competitionId],
  );
  const entries = await database.unsafe<{
    id: string;
    division_id: string;
    name: string;
    entry_type: string;
    seed: number | null;
    status: string;
    created_at: Date | string;
  }>(
    `SELECT e.id,e.division_id,e.name,e.entry_type,e.seed,e.status,e.created_at
     FROM division_entries e JOIN divisions d ON d.id=e.division_id
     WHERE d.competition_id=$1 ORDER BY e.created_at,e.id`,
    [competitionId],
  );
  const graphs = await database.unsafe<{ division_id: string; definition: PlaceholderFormatGraph | string }>(
    `SELECT division_id,definition FROM format_revisions WHERE competition_id=$1 AND status='published'`,
    [competitionId],
  );
  const graphByDivision = new Map(graphs.map((row) => [row.division_id, decoded(row.definition)]));
  const labels = resolvePlaceholderLabels(
    divisions.map((division) => ({
      id: division.id,
      shortCode: division.short_code,
      graph: graphByDivision.get(division.id) ?? null,
      entries: entries
        .filter((entry) => entry.division_id === division.id)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          entryType: entry.entry_type,
          seed: entry.seed,
          createdAt: entry.created_at,
        })),
    })),
  );
  const groupsByDivision = new Map<string, readonly PlaceholderGroup[]>();
  const entryIdBySeed = new Map<string, Map<number, string>>();
  for (const division of divisions) {
    groupsByDivision.set(division.id, placeholderGroupsFromGraph(graphByDivision.get(division.id)));
    const bySeed = new Map<number, string>();
    const activeSeeds = new Set<number>();
    for (const entry of entries) {
      if (entry.division_id !== division.id || typeof entry.seed !== "number") continue;
      const active = entry.status === "active" || entry.status === "confirmed";
      // An active entry owns its seed over any withdrawn/replaced row that kept the same number.
      if (activeSeeds.has(entry.seed) && !active) continue;
      bySeed.set(entry.seed, entry.id);
      if (active) activeSeeds.add(entry.seed);
    }
    entryIdBySeed.set(division.id, bySeed);
  }
  return { labels, groupsByDivision, entryIdBySeed, multiDivision: divisions.length > 1 };
}
