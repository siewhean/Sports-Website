import { createHash } from "node:crypto";
import {
  CANOE_POLO_DEFAULT_SETTINGS,
  DEFAULT_CANOE_POLO_STANDINGS_CONFIG,
  calculateCanoePoloStandings,
  detectCorrectionConflicts,
  generateBalancedCanoePoloFormat,
  generateDeterministicSchedule,
  reduceCanoePoloScoreEvents,
  resolveBracket,
  validateScoreFinalisation,
  type BalancedCanoePoloFormat,
  type CanoePoloResult,
  type CanoePoloScoreEvent,
  type MatchNode,
  type MatchParticipantSource,
} from "@matchday/domain";
import type { NormalizedMatch, PersistedScoreEvent, Phase2DomainAdapter } from "./phase-2-runtime.js";

function stableUuid(namespace: string, localId: string): string {
  const bytes = createHash("sha256").update(`${namespace}:${localId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatValue(value: Record<string, unknown>): BalancedCanoePoloFormat {
  return (typeof value === "string" ? JSON.parse(value) : value) as unknown as BalancedCanoePoloFormat;
}

function mapSource(source: MatchParticipantSource, ids: ReadonlyMap<string, string>): MatchParticipantSource {
  if (source.type === "winner" || source.type === "loser") {
    const matchId = ids.get(source.matchId);
    if (!matchId) throw new Error(`Unknown format match ${source.matchId}`);
    return { ...source, matchId };
  }
  return source;
}

function normalizedFormat(
  format: BalancedCanoePoloFormat,
  namespace: string,
): { definition: BalancedCanoePoloFormat; matches: NormalizedMatch[] } {
  const ids = new Map(format.matches.map((match) => [match.id, stableUuid(namespace, match.id)]));
  const matches = format.matches.map((match): NormalizedMatch => {
    const id = ids.get(match.id);
    if (!id) throw new Error(`Unknown format match ${match.id}`);
    const mappedHome = mapSource(match.home, ids);
    const mappedAway = mapSource(match.away, ids);
    return {
      id,
      code: match.id,
      stage: match.stage,
      roundNumber: match.round,
      ordinal: match.order,
      homeEntryId: match.home.type === "entry" ? match.home.entryId : null,
      awayEntryId: match.away.type === "entry" ? match.away.entryId : null,
      dependencies: match.dependencyMatchIds.map((dependency) => {
        const sourceMatchId = ids.get(dependency);
        if (!sourceMatchId) throw new Error(`Unknown dependency ${dependency}`);
        const homeDirect =
          (mappedHome.type === "winner" || mappedHome.type === "loser") && mappedHome.matchId === sourceMatchId;
        const awayDirect =
          (mappedAway.type === "winner" || mappedAway.type === "loser") && mappedAway.matchId === sourceMatchId;
        return {
          slot: homeDirect ? ("home" as const) : awayDirect ? ("away" as const) : null,
          sourceMatchId,
          outcome: homeDirect ? mappedHome.type : awayDirect ? mappedAway.type : null,
        };
      }),
    };
  });
  return {
    definition: {
      ...format,
      id: stableUuid(namespace, format.id),
      groups: format.groups.map((group) => ({
        ...group,
        matchIds: group.matchIds.map((id) => ids.get(id) ?? id),
      })),
      matches: format.matches.map((match): MatchNode => ({
        ...match,
        id: ids.get(match.id) ?? match.id,
        home: mapSource(match.home, ids),
        away: mapSource(match.away, ids),
        dependencyMatchIds: match.dependencyMatchIds.map((id) => ids.get(id) ?? id),
      })),
      knockoutMatchIds: format.knockoutMatchIds.map((id) => ids.get(id) ?? id),
    },
    matches,
  };
}

function domainScoreEvent(
  event: PersistedScoreEvent,
  match: { matchId: string; homeEntryId: string; awayEntryId: string },
): CanoePoloScoreEvent | null {
  if (event.type === "correction") return null;
  const base = {
    eventId: event.clientEventId,
    clientEventId: event.clientEventId,
    matchId: match.matchId,
    sequence: event.sequence,
    actorId: "access-pass",
    scoringSessionId: "server-confirmed",
    deviceTimestamp: event.occurredAt.toISOString(),
    period: (event.manualPeriod ?? 1) as 1 | 2,
    manualTimeSeconds: event.manualEventSeconds ?? 0,
  };
  const teamId = event.teamSlot === "home" ? match.homeEntryId : event.teamSlot === "away" ? match.awayEntryId : null;
  switch (event.type) {
    case "match_started":
      return { ...base, type: "match_started" };
    case "period_changed":
      return { ...base, type: "period_changed", payload: { period: base.period } };
    case "goal_added":
      return { ...base, type: "goal_added", payload: { teamId: teamId ?? "", scorerId: event.scorer } };
    case "goal_reversed":
      return {
        ...base,
        type: "goal_reversed",
        reversalTargetEventId: String(event.payload.reversal_target_event_id ?? ""),
        reason: event.correctionReason ?? String(event.payload.reason ?? ""),
      };
    case "card_added":
      return {
        ...base,
        type: "card_added",
        payload: {
          teamId: teamId ?? "",
          personId: String(event.payload.person_id ?? ""),
          colour: String(event.payload.colour ?? "") as "green" | "yellow" | "red",
        },
      };
    case "card_reversed":
      return {
        ...base,
        type: "card_reversed",
        reversalTargetEventId: String(event.payload.reversal_target_event_id ?? ""),
        reason: event.correctionReason ?? String(event.payload.reason ?? ""),
      };
    case "timeout_added":
      return { ...base, type: "timeout_added", payload: { teamId: teamId ?? "" } };
    case "incident_added":
      return {
        ...base,
        type: "incident_added",
        payload: {
          teamId,
          personId: typeof event.payload.person_id === "string" ? event.payload.person_id : null,
          note: String(event.payload.note ?? ""),
        },
      };
    case "match_finalised":
      return { ...base, type: "match_finalised" };
    case "match_reopened":
      return { ...base, type: "match_reopened", reason: event.correctionReason ?? String(event.payload.reason ?? "") };
  }
}

export const phase2DomainAdapter: Phase2DomainAdapter = {
  defaultSettings: {
    ...CANOE_POLO_DEFAULT_SETTINGS,
    periodCount: CANOE_POLO_DEFAULT_SETTINGS.periods,
    periodMinutes: 10,
    pointsWin: 3,
    pointsDraw: 1,
    pointsLoss: 0,
    tiebreakOrder: CANOE_POLO_DEFAULT_SETTINGS.standingsCriteria,
    disciplineWeights: { green: 0, yellow: 1, red: 3 },
  },

  generateFormat(entries) {
    const format = generateBalancedCanoePoloFormat(entries);
    const namespace = entries
      .map((entry) => `${entry.id}:${entry.seed}`)
      .sort()
      .join("|");
    return normalizedFormat(format, namespace);
  },

  generateSchedule(matches, intervals) {
    const intervalInputs = intervals.map((interval, index) => ({
      id: `window-${index}-${interval.playingAreaId}`,
      areaId: interval.playingAreaId,
      startMinute: Math.floor(interval.startsAt.getTime() / 60_000),
      endMinute: Math.floor(interval.endsAt.getTime() / 60_000),
    }));
    const domainMatches: MatchNode[] = matches.map((match) => ({
      id: match.id,
      stage: match.stage,
      round: match.roundNumber,
      order: match.ordinal,
      home: match.homeEntryId
        ? { type: "entry", entryId: match.homeEntryId }
        : { type: "group_rank", groupId: `home-${match.id}`, rank: 1 },
      away: match.awayEntryId
        ? { type: "entry", entryId: match.awayEntryId }
        : { type: "group_rank", groupId: `away-${match.id}`, rank: 1 },
      dependencyMatchIds: match.dependencies.map((dependency) => dependency.sourceMatchId),
    }));
    return generateDeterministicSchedule(domainMatches, intervalInputs).map((item) => ({
      matchId: item.matchId,
      playingAreaId: item.areaId,
      startsAt: new Date(item.startMinute * 60_000),
      endsAt: new Date(item.endMinute * 60_000),
    }));
  },

  reduceScore(events, match) {
    const domainEvents = events
      .map((event) => domainScoreEvent(event, match))
      .filter((event): event is CanoePoloScoreEvent => event !== null);
    const state = reduceCanoePoloScoreEvents(domainEvents);
    const validation = validateScoreFinalisation(state);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    return {
      homeScore: state.scoreByTeam[match.homeEntryId] ?? 0,
      awayScore: state.scoreByTeam[match.awayEntryId] ?? 0,
      state: "final",
      snapshot: state as unknown as Record<string, unknown>,
    };
  },

  calculateStandings({ entries, results, settings }) {
    const domainResults: CanoePoloResult[] = results
      .filter((result) => result.homeEntryId !== null && result.awayEntryId !== null)
      .map((result, index) => ({
        matchId: result.matchId,
        homeEntryId: result.homeEntryId ?? "",
        awayEntryId: result.awayEntryId ?? "",
        homeGoals: result.homeScore,
        awayGoals: result.awayScore,
        status: result.state,
        version: index + 1,
      }));
    const standings = calculateCanoePoloStandings(entries, domainResults, {
      ...DEFAULT_CANOE_POLO_STANDINGS_CONFIG,
      winPoints: Number(settings.pointsWin ?? 3),
      drawPoints: Number(settings.pointsDraw ?? 1),
      lossPoints: Number(settings.pointsLoss ?? 0),
    });
    return { standings, explanation: standings.map((row) => ({ entry_id: row.entryId, rules: row.explanations })) };
  },

  resolveBracket({ format, results, entries }) {
    const domainResults: CanoePoloResult[] = results
      .filter((result) => result.homeEntryId !== null && result.awayEntryId !== null)
      .map((result, index) => ({
        matchId: result.matchId,
        homeEntryId: result.homeEntryId ?? "",
        awayEntryId: result.awayEntryId ?? "",
        homeGoals: result.homeScore,
        awayGoals: result.awayScore,
        status: result.state,
        version: index + 1,
      }));
    const parsed = formatValue(format);
    // V1 uses the Phase 3 canonical graph format. It has no legacy `groups`
    // array for this adapter to resolve; its advancement is already owned by
    // the graph projection. A round-robin finalisation must still publish its
    // result and standings rather than failing while attempting a second,
    // incompatible bracket interpretation.
    if (!Array.isArray(parsed.groups)) {
      return { bracket: { matches: [], qualifiedEntryIds: [], championEntryId: null } };
    }
    const groupRankings = Object.fromEntries(
      parsed.groups.map((group) => {
        const groupEntries = entries.filter((entry) => group.entryIds.includes(entry.id));
        const groupResults = domainResults.filter((result) => group.matchIds.includes(result.matchId));
        const ranking = calculateCanoePoloStandings(groupEntries, groupResults);
        return [group.id, ranking.map((row) => row.entryId)];
      }),
    );
    return { bracket: resolveBracket(parsed, domainResults, groupRankings) };
  },

  correctionConflicts({ format, results, correctedMatchId, downstreamStates }) {
    const domainResults: CanoePoloResult[] = results
      .filter((result) => result.homeEntryId !== null && result.awayEntryId !== null)
      .map((result, index) => ({
        matchId: result.matchId,
        homeEntryId: result.homeEntryId ?? "",
        awayEntryId: result.awayEntryId ?? "",
        homeGoals: result.homeScore,
        awayGoals: result.awayScore,
        status: result.state,
        version: index + 1,
      }));
    return detectCorrectionConflicts(formatValue(format), domainResults, correctedMatchId, downstreamStates);
  },
};
