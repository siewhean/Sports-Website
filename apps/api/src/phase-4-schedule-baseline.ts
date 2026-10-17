import type { ScheduleConstraints } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";

/** Previous placement of each match, keyed by match id, as the solver's preserve-existing input. */
export type ScheduleBaseline = ScheduleConstraints["preserve_existing_schedule"]["value"]["by_match_id"];

/** Weight given to keeping the previous revision when the request left preservation off. */
export const PRESERVE_PREVIOUS_REVISION_WEIGHT = 4;

/**
 * Previous revision as the baseline for minimal-change regeneration. The server owns the
 * baseline the way it owns locks and official availability: `by_match_id` always reflects the
 * competition's latest published schedule revision, restricted to matches in the
 * problem, so a client echoing an earlier job's constraints can never pin a stale revision.
 * A request that turned preservation off is promoted to `preferred`: regenerating from an
 * existing revision keeps every unlocked match whose previous slot is still valid, and only the
 * displaced ones move. Mode, weight and shift tolerance of a request that already preserves are
 * kept. With no published revision the server-owned placement map is cleared.
 */
export function withPreviousRevisionBaseline(
  constraints: ScheduleConstraints,
  baseline: ScheduleBaseline,
): ScheduleConstraints {
  if (Object.keys(baseline).length === 0) {
    return {
      ...constraints,
      preserve_existing_schedule: {
        ...constraints.preserve_existing_schedule,
        value: { ...constraints.preserve_existing_schedule.value, by_match_id: {} },
      },
    };
  }
  const requested = constraints.preserve_existing_schedule;
  const preserving = requested.mode !== "ignored";
  return {
    ...constraints,
    preserve_existing_schedule: {
      mode: preserving ? requested.mode : "preferred",
      value: { maximum_shift_minutes: requested.value.maximum_shift_minutes, by_match_id: baseline },
      ...(preserving
        ? requested.weight !== undefined
          ? { weight: requested.weight }
          : {}
        : { weight: PRESERVE_PREVIOUS_REVISION_WEIGHT }),
    },
  };
}

/**
 * Placements from the competition's latest published schedule revision for the given matches. Empty when
 * the competition has never been scheduled. Placements whose slot no longer exists are kept: the
 * solver treats them as displaced and moves only those.
 */
export async function loadPreviousRevisionBaseline(
  tx: PostgresJsSql,
  competitionId: string,
  matchIds: ReadonlySet<string>,
): Promise<ScheduleBaseline> {
  if (matchIds.size === 0) return {};
  const rows = await tx.unsafe<{ match_id: string; playing_area_id: string; starts_at: Date | string }>(
    `SELECT sm.match_id,sm.playing_area_id,sm.starts_at
       FROM scheduled_matches sm
       WHERE sm.schedule_revision_id=(
         SELECT id FROM schedule_revisions WHERE competition_id=$1 AND status='published' ORDER BY revision DESC,id DESC LIMIT 1
       )
       ORDER BY sm.match_id`,
    [competitionId],
  );
  const baseline: ScheduleBaseline = {};
  for (const row of rows) {
    if (!matchIds.has(row.match_id)) continue;
    baseline[row.match_id] = { area_id: row.playing_area_id, start_epoch_ms: new Date(row.starts_at).getTime() };
  }
  return baseline;
}
