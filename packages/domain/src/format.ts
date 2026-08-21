import type { CompetitionEntry } from "./canoe-polo.js";

export type MatchParticipantSource =
  | { type: "entry"; entryId: string }
  | { type: "group_rank"; groupId: string; rank: number }
  | { type: "winner"; matchId: string }
  | { type: "loser"; matchId: string };

export type MatchStage = "group" | "quarterfinal" | "semifinal" | "bronze" | "final";

export type MatchNode = {
  id: string;
  stage: MatchStage;
  round: number;
  order: number;
  home: MatchParticipantSource;
  away: MatchParticipantSource;
  dependencyMatchIds: readonly string[];
};

export type FormatGroup = {
  id: string;
  entryIds: readonly string[];
  matchIds: readonly string[];
};

export type BalancedCanoePoloFormat = {
  id: string;
  version: 1;
  entryCount: 8 | 16;
  groups: readonly FormatGroup[];
  matches: readonly MatchNode[];
  knockoutMatchIds: readonly string[];
};

function validateEntries(
  entries: readonly CompetitionEntry[],
): asserts entries is readonly CompetitionEntry[] & { length: 8 | 16 } {
  if (entries.length !== 8 && entries.length !== 16) {
    throw new Error("Balanced Canoe Polo format requires exactly 8 or 16 entries");
  }
  const ids = new Set<string>();
  const seeds = new Set<number>();
  for (const entry of entries) {
    if (!entry.id || !entry.name) throw new Error("Every entry requires an ID and name");
    if (ids.has(entry.id)) throw new Error(`Duplicate entry ID: ${entry.id}`);
    if (!Number.isInteger(entry.seed) || entry.seed < 1 || entry.seed > entries.length) {
      throw new Error(`Entry ${entry.id} has invalid seed ${entry.seed}`);
    }
    if (seeds.has(entry.seed)) throw new Error(`Duplicate seed: ${entry.seed}`);
    ids.add(entry.id);
    seeds.add(entry.seed);
  }
}

function snakeGroups(entries: readonly CompetitionEntry[], groupCount: number): CompetitionEntry[][] {
  const groups = Array.from({ length: groupCount }, () => [] as CompetitionEntry[]);
  [...entries]
    .sort((left, right) => left.seed - right.seed || left.id.localeCompare(right.id))
    .forEach((entry, index) => {
      const row = Math.floor(index / groupCount);
      const offset = index % groupCount;
      const groupIndex = row % 2 === 0 ? offset : groupCount - 1 - offset;
      groups[groupIndex]?.push(entry);
    });
  return groups;
}

// Circle-method order for four-team groups. Each entry plays once per group round.
const FOUR_TEAM_ROUNDS = [
  [
    [0, 3],
    [1, 2],
  ],
  [
    [0, 2],
    [3, 1],
  ],
  [
    [0, 1],
    [2, 3],
  ],
] as const;

function groupMatches(groupId: string, entries: readonly CompetitionEntry[], orderStart: number): MatchNode[] {
  return FOUR_TEAM_ROUNDS.flatMap((roundPairs, roundIndex) =>
    roundPairs.map((pair, pairIndex) => {
      const home = entries[pair[0]];
      const away = entries[pair[1]];
      if (!home || !away) throw new Error(`Group ${groupId} does not contain four entries`);
      return {
        id: `group-${groupId}-r${roundIndex + 1}-m${pairIndex + 1}`,
        stage: "group" as const,
        round: roundIndex + 1,
        order: orderStart + roundIndex * 2 + pairIndex,
        home: { type: "entry" as const, entryId: home.id },
        away: { type: "entry" as const, entryId: away.id },
        dependencyMatchIds: [],
      };
    }),
  );
}

function groupDependencies(groups: readonly FormatGroup[], ...groupIds: string[]): string[] {
  return groups.filter((group) => groupIds.includes(group.id)).flatMap((group) => group.matchIds);
}

export function generateBalancedCanoePoloFormat(entries: readonly CompetitionEntry[]): BalancedCanoePoloFormat {
  validateEntries(entries);
  const groupCount = entries.length / 4;
  const assignedGroups = snakeGroups(entries, groupCount);
  const allGroupMatches: MatchNode[] = [];
  const groups: FormatGroup[] = assignedGroups.map((groupEntries, index) => {
    const id = String.fromCharCode(65 + index);
    const matches = groupMatches(id, groupEntries, index * 6 + 1);
    allGroupMatches.push(...matches);
    return { id, entryIds: groupEntries.map((entry) => entry.id), matchIds: matches.map((match) => match.id) };
  });

  const groupMatchCount = allGroupMatches.length;
  const knockout: MatchNode[] = [];
  if (entries.length === 8) {
    knockout.push(
      {
        id: "semifinal-1",
        stage: "semifinal",
        round: 4,
        order: groupMatchCount + 1,
        home: { type: "group_rank", groupId: "A", rank: 1 },
        away: { type: "group_rank", groupId: "B", rank: 2 },
        dependencyMatchIds: groupDependencies(groups, "A", "B"),
      },
      {
        id: "semifinal-2",
        stage: "semifinal",
        round: 4,
        order: groupMatchCount + 2,
        home: { type: "group_rank", groupId: "B", rank: 1 },
        away: { type: "group_rank", groupId: "A", rank: 2 },
        dependencyMatchIds: groupDependencies(groups, "A", "B"),
      },
    );
  } else {
    const quarterfinalPairs = [
      ["A", 1, "B", 2],
      ["C", 1, "D", 2],
      ["B", 1, "A", 2],
      ["D", 1, "C", 2],
    ] as const;
    quarterfinalPairs.forEach(([homeGroup, homeRank, awayGroup, awayRank], index) => {
      knockout.push({
        id: `quarterfinal-${index + 1}`,
        stage: "quarterfinal",
        round: 4,
        order: groupMatchCount + index + 1,
        home: { type: "group_rank", groupId: homeGroup, rank: homeRank },
        away: { type: "group_rank", groupId: awayGroup, rank: awayRank },
        dependencyMatchIds: groupDependencies(groups, homeGroup, awayGroup),
      });
    });
    knockout.push(
      {
        id: "semifinal-1",
        stage: "semifinal",
        round: 5,
        order: groupMatchCount + 5,
        home: { type: "winner", matchId: "quarterfinal-1" },
        away: { type: "winner", matchId: "quarterfinal-2" },
        dependencyMatchIds: ["quarterfinal-1", "quarterfinal-2"],
      },
      {
        id: "semifinal-2",
        stage: "semifinal",
        round: 5,
        order: groupMatchCount + 6,
        home: { type: "winner", matchId: "quarterfinal-3" },
        away: { type: "winner", matchId: "quarterfinal-4" },
        dependencyMatchIds: ["quarterfinal-3", "quarterfinal-4"],
      },
    );
  }

  const finalRound = entries.length === 8 ? 5 : 6;
  knockout.push(
    {
      id: "bronze-final",
      stage: "bronze",
      round: finalRound,
      order: groupMatchCount + knockout.length + 1,
      home: { type: "loser", matchId: "semifinal-1" },
      away: { type: "loser", matchId: "semifinal-2" },
      dependencyMatchIds: ["semifinal-1", "semifinal-2"],
    },
    {
      id: "championship-final",
      stage: "final",
      round: finalRound,
      order: groupMatchCount + knockout.length + 2,
      home: { type: "winner", matchId: "semifinal-1" },
      away: { type: "winner", matchId: "semifinal-2" },
      dependencyMatchIds: ["semifinal-1", "semifinal-2"],
    },
  );

  return {
    id: `canoe-polo-balanced-${entries.length}`,
    version: 1,
    entryCount: entries.length,
    groups,
    matches: [...allGroupMatches, ...knockout],
    knockoutMatchIds: knockout.map((match) => match.id),
  };
}

// Phase 3 sport-neutral format engine. The Phase 2 Canoe Polo API above is
// deliberately retained because published competitions depend on its IDs and
// match ordering.

export const defaultFormatEntryCounts = [8, 12, 16, 24, 48] as const;
export type DefaultFormatEntryCount = (typeof defaultFormatEntryCounts)[number];

export type FormatStageKind =
  "round_robin" | "group" | "single_elimination" | "placement" | "consolation" | "classification" | "bronze";

export type FormatParticipantSource =
  | { readonly type: "entry_seed"; readonly seed: number }
  | {
      readonly type: "stage_rank";
      readonly stageId: string;
      readonly groupId?: string;
      readonly rank: number;
    }
  | { readonly type: "manual_qualifier"; readonly qualifierId: string; readonly stageId: string }
  | { readonly type: "winner"; readonly matchId: string }
  | { readonly type: "loser"; readonly matchId: string };

export type FormatGraphMatch = {
  readonly id: string;
  readonly stageId: string;
  readonly poolId?: string;
  readonly round: number;
  readonly order: number;
  readonly purpose: "pool" | "progression" | "championship" | "placement" | "classification";
  readonly home: FormatParticipantSource;
  readonly away: FormatParticipantSource;
};

export type FormatGraphStage = {
  readonly id: string;
  readonly label: string;
  readonly kind: FormatStageKind;
  readonly order: number;
  readonly groupIds: readonly string[];
  readonly groupSize: number | null;
  readonly outputRanks: number;
  readonly matchIds: readonly string[];
  /** Phase 4 manual-builder values; legacy Phase 3 graphs may omit them. */
  readonly repetitions?: number;
  readonly qualificationPositions?: readonly number[];
  readonly additionalQualifiers?: readonly {
    readonly method: "best_across_groups" | "bottom_from_each_group" | "manual";
    readonly count: number;
    readonly destinationStageId: string;
  }[];
  readonly destinationStageIds?: readonly string[];
  readonly seeding?: "seeded" | "snake" | "random" | "manual";
  readonly placementRule?: {
    readonly coverage: "champion_only" | "podium" | "full" | "custom";
    readonly positions: readonly number[];
  };
  readonly carriedResults?: "none" | "head_to_head" | "all";
};

export type FormatGraph = {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly entryCount: number;
  readonly stages: readonly FormatGraphStage[];
  readonly matches: readonly FormatGraphMatch[];
  readonly terminalMatchIds: readonly string[];
};

export type FormatValidationIssueCode =
  | "invalid_schema_version"
  | "invalid_shape"
  | "invalid_enum"
  | "invalid_entry_count"
  | "duplicate_stage_id"
  | "duplicate_match_id"
  | "duplicate_stage_order"
  | "duplicate_match_order"
  | "duplicate_slot"
  | "unknown_stage"
  | "unknown_match"
  | "unknown_group"
  | "impossible_rank"
  | "invalid_seed"
  | "incomplete_seed_coverage"
  | "invalid_stage_shape"
  | "invalid_dependency_order"
  | "cycle"
  | "orphan_stage"
  | "orphan_match"
  | "invalid_terminal"
  | "invalid_layout"
  | "invalid_advancement";

export type FormatValidationIssue = {
  readonly code: FormatValidationIssueCode;
  readonly path: string;
  readonly message: string;
};

export type FormatValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly FormatValidationIssue[] };

export type FormatRevision = {
  readonly formatId: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly graph: FormatGraph;
};

export type FormatMetrics = {
  readonly matchCount: number;
  readonly guaranteedMatches: number;
  readonly maximumMatches: number;
};

export type FormatTemplateStrategy = "full_placement" | "championship_focus" | "compact_knockout";

export type FormatTemplate = {
  readonly id: string;
  readonly label: string;
  readonly strategy: FormatTemplateStrategy;
  readonly advantage: string;
  readonly graph: FormatGraph;
  readonly metrics: FormatMetrics;
};

export type FormatRecommendationRequest = {
  readonly entryCount: number;
  readonly availableMatchSlots: number;
  readonly minimumGuaranteedMatches?: number;
  readonly maximumMatchCount?: number;
  readonly includeInfeasible?: boolean;
};

export type FormatRecommendation = {
  readonly rank: number;
  readonly templateId: string;
  readonly label: string;
  readonly advantage: string;
  readonly feasible: boolean;
  readonly requiredMatchSlots: number;
  readonly availableMatchSlots: number;
  readonly spareMatchSlots: number;
  readonly guaranteedMatches: number;
  readonly reasons: readonly string[];
  readonly graph: FormatGraph;
};

export type CompetitionFormatRecommendationRequest = {
  readonly sportCode: string;
  readonly divisions: readonly Readonly<{ id: string; entryCount: number }>[];
  readonly availableMatchSlots: number;
  readonly minimumGuaranteedMatches?: number;
  readonly rankAllEntries?: boolean;
  readonly knockoutRequired?: boolean;
  readonly placementRequired?: boolean;
  readonly crossGroupAllowed?: boolean;
  readonly priority?: "speed" | "simplicity" | "participation";
};

export type CompetitionFormatRecommendation = {
  readonly id: string;
  readonly strategy: FormatTemplateStrategy;
  readonly label: string;
  readonly advantage: string;
  readonly capacityStatus: "fits" | "tight" | "requires_changes";
  readonly scheduleFeasibility: "infeasible" | "not_checked";
  readonly matchCount: number;
  readonly guaranteedMatches: number;
  readonly rankingCoverage: "all_entries" | "podium" | "champion";
  readonly availableMatchSlots: number;
  readonly spareMatchSlots: number;
  readonly divisions: readonly Readonly<{
    divisionId: string;
    entryCount: number;
    graph: FormatGraph;
    matchCount: number;
    guaranteedMatches: number;
  }>[];
  readonly warningCodes: readonly string[];
};

export type CompetitionFormatRecommendationSet = {
  readonly recommendations: readonly CompetitionFormatRecommendation[];
  readonly requiresChanges: CompetitionFormatRecommendation | null;
};

type MutableStage = {
  id: string;
  label: string;
  kind: FormatStageKind;
  order: number;
  groupIds: string[];
  groupSize: number | null;
  outputRanks: number;
  matchIds: string[];
};

const formatStageKinds = new Set<string>([
  "round_robin",
  "group",
  "single_elimination",
  "placement",
  "consolation",
  "classification",
  "bronze",
]);
const matchPurposes = new Set<string>(["pool", "progression", "championship", "placement", "classification"]);
const participantSourceTypes = new Set<string>(["entry_seed", "stage_rank", "manual_qualifier", "winner", "loser"]);
const seedingModes = new Set<string>(["seeded", "snake", "random", "manual"]);
const carriedResultModes = new Set<string>(["none", "head_to_head", "all"]);
const placementCoverages = new Set<string>(["champion_only", "podium", "full", "custom"]);
const additionalQualifierMethods = new Set<string>(["best_across_groups", "bottom_from_each_group", "manual"]);

function hasKnownParticipantSourceType(source: FormatParticipantSource): boolean {
  return participantSourceTypes.has((source as { readonly type?: unknown }).type as string);
}

function sourceKey(source: FormatParticipantSource): string {
  switch (source.type) {
    case "entry_seed":
      return `seed:${source.seed}`;
    case "stage_rank":
      return `rank:${source.stageId}:${source.groupId ?? "*"}:${source.rank}`;
    case "manual_qualifier":
      return `manual:${source.qualifierId}`;
    case "winner":
    case "loser":
      return `${source.type}:${source.matchId}`;
  }
}

function pushIssue(
  issues: FormatValidationIssue[],
  code: FormatValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

export function validateFormatGraph(graph: FormatGraph): FormatValidationResult {
  const issues: FormatValidationIssue[] = [];
  if (graph.schemaVersion !== 1) {
    pushIssue(issues, "invalid_schema_version", "schemaVersion", "Format graph schema version must be 1");
  }
  if (!Number.isInteger(graph.entryCount) || graph.entryCount < 2) {
    pushIssue(issues, "invalid_entry_count", "entryCount", "Entry count must be an integer of at least two");
  }

  const stages = new Map<string, FormatGraphStage>();
  const stageOrders = new Set<number>();
  graph.stages.forEach((stage, stageIndex) => {
    const path = `stages[${stageIndex}]`;
    if (typeof stage.label !== "string" || stage.label.trim().length === 0) {
      pushIssue(issues, "invalid_stage_shape", `${path}.label`, "Stage name must not be blank");
    }
    if (!formatStageKinds.has(stage.kind)) {
      pushIssue(issues, "invalid_enum", `${path}.kind`, `Unsupported stage kind ${String(stage.kind)}`);
    }
    if (!stage.id || stages.has(stage.id)) {
      pushIssue(issues, "duplicate_stage_id", `${path}.id`, `Stage ID ${stage.id || "<empty>"} is not unique`);
    } else {
      stages.set(stage.id, stage);
    }
    if (!Number.isInteger(stage.order) || stage.order < 1 || stageOrders.has(stage.order)) {
      pushIssue(
        issues,
        "duplicate_stage_order",
        `${path}.order`,
        `Stage order ${stage.order} is invalid or duplicated`,
      );
    }
    stageOrders.add(stage.order);
    if (stage.outputRanks < 1 || !Number.isInteger(stage.outputRanks)) {
      pushIssue(issues, "invalid_stage_shape", `${path}.outputRanks`, "A stage must expose at least one integer rank");
    }
    if (stage.matchIds.length === 0) {
      pushIssue(issues, "orphan_stage", `${path}.matchIds`, `Stage ${stage.id} does not contain any matches`);
    }
    if (stage.kind === "group") {
      if (stage.groupIds.length < 1 || !Number.isInteger(stage.groupSize) || (stage.groupSize ?? 0) < 2) {
        pushIssue(issues, "invalid_stage_shape", path, "A group stage requires groups of at least two entries");
      }
      if (new Set(stage.groupIds).size !== stage.groupIds.length) {
        pushIssue(issues, "invalid_stage_shape", `${path}.groupIds`, "Group IDs must be unique within a stage");
      }
      if (stage.outputRanks > (stage.groupSize ?? 0)) {
        pushIssue(issues, "impossible_rank", `${path}.outputRanks`, "Group output ranks cannot exceed group size");
      }
      if ((stage.groupSize ?? 0) * stage.groupIds.length !== graph.entryCount) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          path,
          "Group count multiplied by group size must equal the graph entry count",
        );
      }
    } else if (stage.kind === "round_robin") {
      if (stage.outputRanks !== graph.entryCount) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `${path}.outputRanks`,
          "Round-robin output ranks must equal the graph entry count",
        );
      }
    } else if (stage.groupIds.length > 0 || stage.groupSize !== null) {
      pushIssue(issues, "invalid_stage_shape", path, "Only group stages may define group shape");
    }
    if (stage.repetitions !== undefined && (!Number.isInteger(stage.repetitions) || stage.repetitions < 1)) {
      pushIssue(issues, "invalid_stage_shape", `${path}.repetitions`, "Repetitions must be a positive integer");
    }
    if (stage.seeding !== undefined && !seedingModes.has(stage.seeding)) {
      pushIssue(issues, "invalid_enum", `${path}.seeding`, `Unsupported seeding mode ${String(stage.seeding)}`);
    }
    if (stage.carriedResults !== undefined && !carriedResultModes.has(stage.carriedResults)) {
      pushIssue(
        issues,
        "invalid_enum",
        `${path}.carriedResults`,
        `Unsupported carried-results mode ${String(stage.carriedResults)}`,
      );
    }
    if (stage.qualificationPositions !== undefined) {
      const unique = new Set(stage.qualificationPositions);
      if (
        unique.size !== stage.qualificationPositions.length ||
        stage.qualificationPositions.some(
          (position) => !Number.isInteger(position) || position < 1 || position > stage.outputRanks,
        )
      ) {
        pushIssue(
          issues,
          "impossible_rank",
          `${path}.qualificationPositions`,
          "Qualification positions must be unique ranks exposed by the stage",
        );
      }
    }
    if (
      stage.destinationStageIds !== undefined &&
      new Set(stage.destinationStageIds).size !== stage.destinationStageIds.length
    ) {
      pushIssue(issues, "duplicate_slot", `${path}.destinationStageIds`, "Destination stages must be unique");
    }
    if (stage.placementRule !== undefined) {
      const positions = stage.placementRule.positions;
      if (!placementCoverages.has(stage.placementRule.coverage)) {
        pushIssue(
          issues,
          "invalid_enum",
          `${path}.placementRule.coverage`,
          `Unsupported placement coverage ${String(stage.placementRule.coverage)}`,
        );
      }
      if (
        positions.length === 0 ||
        new Set(positions).size !== positions.length ||
        positions.some((position) => !Number.isInteger(position) || position < 1 || position > graph.entryCount)
      ) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `${path}.placementRule.positions`,
          "Placement positions must be unique entrant ranks",
        );
      }
      const ordered = [...positions].sort((left, right) => left - right);
      if (positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? 0))) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `${path}.placementRule.positions`,
          "Placement positions must use canonical ascending order",
        );
      }
      const expected =
        stage.placementRule.coverage === "champion_only"
          ? [1]
          : stage.placementRule.coverage === "podium"
            ? [1, 2, 3]
            : stage.placementRule.coverage === "full"
              ? Array.from({ length: graph.entryCount }, (_, index) => index + 1)
              : ordered;
      if (
        stage.placementRule.coverage !== "custom" &&
        (ordered.length !== expected.length || ordered.some((position, index) => position !== expected[index]))
      ) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `${path}.placementRule.positions`,
          `Placement coverage ${stage.placementRule.coverage} does not match its required positions`,
        );
      }
    }
  });

  graph.stages.forEach((stage, stageIndex) => {
    const destinations = [
      ...(stage.destinationStageIds ?? []),
      ...(stage.additionalQualifiers ?? []).map((rule) => rule.destinationStageId),
    ];
    for (const destinationId of destinations) {
      const destination = stages.get(destinationId);
      if (!destination) {
        pushIssue(
          issues,
          "unknown_stage",
          `stages[${stageIndex}].destinationStageIds`,
          `Unknown destination stage ${destinationId}`,
        );
      } else if (destination.order <= stage.order) {
        pushIssue(
          issues,
          "invalid_dependency_order",
          `stages[${stageIndex}].destinationStageIds`,
          `Destination stage ${destinationId} must follow ${stage.id}`,
        );
      }
    }
    for (const [ruleIndex, rule] of (stage.additionalQualifiers ?? []).entries()) {
      if (!additionalQualifierMethods.has(rule.method)) {
        pushIssue(
          issues,
          "invalid_enum",
          `stages[${stageIndex}].additionalQualifiers[${ruleIndex}].method`,
          `Unsupported additional qualifier method ${String(rule.method)}`,
        );
      }
      if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > graph.entryCount) {
        pushIssue(
          issues,
          "impossible_rank",
          `stages[${stageIndex}].additionalQualifiers[${ruleIndex}].count`,
          "Additional qualifier count must be a positive integer within the entry count",
        );
      }
    }
  });

  const matches = new Map<string, FormatGraphMatch>();
  const matchOrders = new Set<number>();
  graph.matches.forEach((match, matchIndex) => {
    const path = `matches[${matchIndex}]`;
    if (!matchPurposes.has(match.purpose)) {
      pushIssue(issues, "invalid_enum", `${path}.purpose`, `Unsupported match purpose ${String(match.purpose)}`);
    }
    if (!match.id || matches.has(match.id)) {
      pushIssue(issues, "duplicate_match_id", `${path}.id`, `Match ID ${match.id || "<empty>"} is not unique`);
    } else {
      matches.set(match.id, match);
    }
    if (!Number.isInteger(match.order) || match.order < 1 || matchOrders.has(match.order)) {
      pushIssue(
        issues,
        "duplicate_match_order",
        `${path}.order`,
        `Match order ${match.order} is invalid or duplicated`,
      );
    }
    matchOrders.add(match.order);
    if (!stages.has(match.stageId)) {
      pushIssue(issues, "unknown_stage", `${path}.stageId`, `Unknown stage ${match.stageId}`);
    }
    const homeTypeValid = hasKnownParticipantSourceType(match.home);
    const awayTypeValid = hasKnownParticipantSourceType(match.away);
    if (!homeTypeValid) {
      pushIssue(
        issues,
        "invalid_enum",
        `${path}.home.type`,
        `Unsupported participant source ${String((match.home as { readonly type?: unknown }).type)}`,
      );
    }
    if (!awayTypeValid) {
      pushIssue(
        issues,
        "invalid_enum",
        `${path}.away.type`,
        `Unsupported participant source ${String((match.away as { readonly type?: unknown }).type)}`,
      );
    }
    if (homeTypeValid && awayTypeValid && sourceKey(match.home) === sourceKey(match.away)) {
      pushIssue(issues, "duplicate_slot", path, `Both match slots use ${sourceKey(match.home)}`);
    }
  });

  const validateCompletePool = (stage: FormatGraphStage, stageIndex: number): void => {
    if (stage.kind !== "group" && stage.kind !== "round_robin") return;
    const stageMatches = stage.matchIds.flatMap((matchId) => {
      const match = matches.get(matchId);
      return match ? [match] : [];
    });
    const poolIds = stage.kind === "group" ? stage.groupIds : [undefined];
    const seenSeedsAcrossGroups = new Set<number>();
    for (const poolId of poolIds) {
      const poolMatches = stageMatches.filter((match) =>
        stage.kind === "group" ? match.poolId === poolId : match.poolId === undefined,
      );
      const participantCount = stage.kind === "group" ? (stage.groupSize ?? 0) : graph.entryCount;
      const repetitions = stage.repetitions ?? 1;
      const expectedMatches = ((participantCount * (participantCount - 1)) / 2) * repetitions;
      if (poolMatches.length !== expectedMatches) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `stages[${stageIndex}].matchIds`,
          `${poolId ?? "Round robin"} requires ${expectedMatches} complete pairings, found ${poolMatches.length}`,
        );
      }
      const pairUses = new Map<string, number>();
      const seedUses = new Map<number, number>();
      for (const match of poolMatches) {
        if (match.home.type !== "entry_seed" || match.away.type !== "entry_seed") {
          pushIssue(
            issues,
            "invalid_stage_shape",
            `matches.${match.id}`,
            "Pool matches must pair seeded entries directly",
          );
          continue;
        }
        const seeds = [match.home.seed, match.away.seed].sort((left, right) => left - right);
        const pairKey = `${seeds[0]}:${seeds[1]}`;
        const uses = (pairUses.get(pairKey) ?? 0) + 1;
        pairUses.set(pairKey, uses);
        if (uses > repetitions) {
          pushIssue(issues, "duplicate_slot", `matches.${match.id}`, `Pool pairing ${pairKey} is duplicated`);
        }
        for (const seed of seeds) seedUses.set(seed, (seedUses.get(seed) ?? 0) + 1);
      }
      if (
        pairUses.size !== (participantCount * (participantCount - 1)) / 2 ||
        [...pairUses.values()].some((uses) => uses !== repetitions) ||
        seedUses.size !== participantCount ||
        [...seedUses.values()].some((uses) => uses !== (participantCount - 1) * repetitions)
      ) {
        pushIssue(
          issues,
          "invalid_stage_shape",
          `stages[${stageIndex}].matchIds`,
          `${poolId ?? "Round robin"} must include every participant exactly ${(participantCount - 1) * repetitions} times`,
        );
      }
      if (stage.kind === "group") {
        for (const seed of seedUses.keys()) {
          if (seenSeedsAcrossGroups.has(seed)) {
            pushIssue(
              issues,
              "duplicate_slot",
              `stages[${stageIndex}].matchIds`,
              `Seed ${seed} appears in more than one group`,
            );
          }
          seenSeedsAcrossGroups.add(seed);
        }
      }
    }
    if (stage.kind === "group" && seenSeedsAcrossGroups.size !== graph.entryCount) {
      pushIssue(
        issues,
        "invalid_stage_shape",
        `stages[${stageIndex}].matchIds`,
        "Group stage must cover every graph entry exactly once",
      );
    }
  };
  graph.stages.forEach(validateCompletePool);

  const matchMembership = new Map<string, number>();
  graph.stages.forEach((stage, stageIndex) => {
    stage.matchIds.forEach((matchId, matchIndex) => {
      const membershipPath = `stages[${stageIndex}].matchIds[${matchIndex}]`;
      const match = matches.get(matchId);
      if (!match) {
        pushIssue(issues, "unknown_match", membershipPath, `Unknown match ${matchId}`);
      } else if (match.stageId !== stage.id) {
        pushIssue(
          issues,
          "unknown_stage",
          membershipPath,
          `Match ${matchId} belongs to ${match.stageId}, not ${stage.id}`,
        );
      }
      matchMembership.set(matchId, (matchMembership.get(matchId) ?? 0) + 1);
    });
  });
  graph.matches.forEach((match, index) => {
    if (matchMembership.get(match.id) !== 1) {
      pushIssue(issues, "orphan_match", `matches[${index}]`, `Match ${match.id} must belong to exactly one stage`);
    }
  });

  const consumedSources = new Map<string, string>();
  const coveredEntrySeeds = new Set<number>();
  const consumers = new Map<string, string[]>();
  const adjacency = new Map<string, string[]>();
  graph.matches.forEach((match, matchIndex) => {
    const matchStage = stages.get(match.stageId);
    for (const [slot, source] of [
      ["home", match.home],
      ["away", match.away],
    ] as const) {
      const path = `matches[${matchIndex}].${slot}`;
      if (!hasKnownParticipantSourceType(source)) continue;
      if (source.type === "entry_seed") {
        if (!Number.isInteger(source.seed) || source.seed < 1 || source.seed > graph.entryCount) {
          pushIssue(issues, "invalid_seed", path, `Seed ${source.seed} is outside 1..${graph.entryCount}`);
        } else {
          coveredEntrySeeds.add(source.seed);
        }
      } else if (source.type === "stage_rank") {
        const sourceStage = stages.get(source.stageId);
        if (!sourceStage) {
          pushIssue(issues, "unknown_stage", path, `Unknown source stage ${source.stageId}`);
        } else {
          if (sourceStage.kind === "group") {
            if (source.groupId !== undefined && !sourceStage.groupIds.includes(source.groupId)) {
              pushIssue(issues, "unknown_group", path, `Unknown group ${source.groupId} in stage ${source.stageId}`);
            }
          } else if (sourceStage.kind === "round_robin") {
            if (source.groupId !== undefined) {
              pushIssue(issues, "unknown_group", path, "Whole-table round-robin ranks do not use a group ID");
            }
          } else {
            pushIssue(issues, "unknown_stage", path, `Stage ${source.stageId} does not publish table ranks`);
          }
          if (!Number.isInteger(source.rank) || source.rank < 1 || source.rank > sourceStage.outputRanks) {
            pushIssue(
              issues,
              "impossible_rank",
              path,
              `Rank ${source.rank} is not produced by stage ${source.stageId}`,
            );
          }
          if (matchStage && sourceStage.order >= matchStage.order) {
            pushIssue(issues, "invalid_dependency_order", path, "Stage ranks may advance only to a later stage");
          }
        }
      } else if (source.type === "manual_qualifier") {
        const sourceStage = stages.get(source.stageId);
        if (typeof source.qualifierId !== "string" || source.qualifierId.trim().length === 0) {
          pushIssue(issues, "invalid_advancement", `${path}.qualifierId`, "Manual qualifier ID must not be blank");
        }
        if (!sourceStage) {
          pushIssue(issues, "unknown_stage", `${path}.stageId`, `Unknown source stage ${source.stageId}`);
        } else if (matchStage && sourceStage.order >= matchStage.order) {
          pushIssue(issues, "invalid_dependency_order", path, "Manual qualifiers may advance only to a later stage");
        }
      } else {
        const sourceMatch = matches.get(source.matchId);
        if (!sourceMatch) {
          pushIssue(issues, "unknown_match", path, `Unknown source match ${source.matchId}`);
        } else {
          if (sourceMatch.id === match.id || sourceMatch.order >= match.order) {
            pushIssue(issues, "invalid_dependency_order", path, "Match outcomes may advance only to a later match");
          }
          const list = consumers.get(sourceMatch.id) ?? [];
          list.push(match.id);
          consumers.set(sourceMatch.id, list);
          const edges = adjacency.get(sourceMatch.id) ?? [];
          edges.push(match.id);
          adjacency.set(sourceMatch.id, edges);
        }
      }

      // Pool entries intentionally appear in several round-robin matches.
      if (matchStage?.kind !== "group" && matchStage?.kind !== "round_robin") {
        const key = sourceKey(source);
        const prior = consumedSources.get(key);
        if (prior) pushIssue(issues, "duplicate_slot", path, `${key} is already consumed by ${prior}`);
        else consumedSources.set(key, match.id);
      }
    }
  });

  if (Number.isInteger(graph.entryCount) && graph.entryCount >= 2 && coveredEntrySeeds.size !== graph.entryCount) {
    pushIssue(
      issues,
      "incomplete_seed_coverage",
      "matches",
      `Every entrant seed in 1..${graph.entryCount} must enter the graph; found ${coveredEntrySeeds.size} distinct seeds`,
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (matchId: string): void => {
    if (visiting.has(matchId)) {
      pushIssue(issues, "cycle", `matches.${matchId}`, `Dependency cycle contains ${matchId}`);
      return;
    }
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const child of adjacency.get(matchId) ?? []) visit(child);
    visiting.delete(matchId);
    visited.add(matchId);
  };
  graph.matches.forEach((match) => visit(match.id));

  const terminals = new Set<string>();
  graph.terminalMatchIds.forEach((matchId, terminalIndex) => {
    if (terminals.has(matchId) || !matches.has(matchId)) {
      pushIssue(
        issues,
        "invalid_terminal",
        `terminalMatchIds[${terminalIndex}]`,
        `Terminal ${matchId} is duplicated or unknown`,
      );
    }
    if ((consumers.get(matchId) ?? []).length > 0) {
      pushIssue(
        issues,
        "invalid_terminal",
        `terminalMatchIds[${terminalIndex}]`,
        `Terminal ${matchId} feeds another match`,
      );
    }
    terminals.add(matchId);
  });
  graph.matches.forEach((match, matchIndex) => {
    const stage = stages.get(match.stageId);
    const isPool = stage?.kind === "group" || stage?.kind === "round_robin";
    if (!isPool && (consumers.get(match.id) ?? []).length === 0 && !terminals.has(match.id)) {
      pushIssue(issues, "orphan_match", `matches[${matchIndex}]`, `Unconsumed match ${match.id} is not terminal`);
    }
  });

  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

export function assertValidFormatGraph(graph: FormatGraph): void {
  const result = validateFormatGraph(graph);
  if (!result.valid) {
    throw new Error(`Invalid format graph: ${result.issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`);
  }
}

function circlePairs(size: number): readonly (readonly [number, number])[][] {
  if (size < 2) return [];
  const participantCount = size % 2 === 0 ? size : size + 1;
  const indexes = Array.from({ length: participantCount }, (_, index) => (index < size ? index : -1));
  const rounds: [number, number][][] = [];
  for (let round = 0; round < participantCount - 1; round += 1) {
    const pairs: [number, number][] = [];
    for (let index = 0; index < participantCount / 2; index += 1) {
      const left = indexes[index];
      const right = indexes[participantCount - 1 - index];
      if (left !== undefined && right !== undefined && left >= 0 && right >= 0) pairs.push([left, right]);
    }
    rounds.push(pairs);
    const fixed = indexes[0];
    const rest = indexes.slice(1);
    const tail = rest.pop();
    if (fixed !== undefined && tail !== undefined) indexes.splice(0, indexes.length, fixed, tail, ...rest);
  }
  return rounds;
}

function buildGroupStage(
  entryCount: number,
  groupSize: number,
): {
  stage: MutableStage;
  matches: FormatGraphMatch[];
  nextOrder: number;
} {
  if (entryCount % groupSize !== 0) throw new Error("Entry count must divide evenly into groups");
  const groupCount = entryCount / groupSize;
  const groupIds = Array.from({ length: groupCount }, (_, index) => `G${index + 1}`);
  const groups = Array.from({ length: groupCount }, () => [] as number[]);
  for (let seed = 1; seed <= entryCount; seed += 1) {
    const index = seed - 1;
    const row = Math.floor(index / groupCount);
    const offset = index % groupCount;
    const groupIndex = row % 2 === 0 ? offset : groupCount - 1 - offset;
    groups[groupIndex]?.push(seed);
  }
  const matches: FormatGraphMatch[] = [];
  for (let round = 0; round < groupSize - 1; round += 1) {
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const group = groups[groupIndex] ?? [];
      const groupId = groupIds[groupIndex] ?? "";
      const pairings = circlePairs(groupSize)[round] ?? [];
      for (let pairIndex = 0; pairIndex < pairings.length; pairIndex += 1) {
        const pair = pairings[pairIndex];
        const homeSeed = pair ? group[pair[0]] : undefined;
        const awaySeed = pair ? group[pair[1]] : undefined;
        if (!homeSeed || !awaySeed) throw new Error(`Unable to create group ${groupId}`);
        matches.push({
          id: `groups-${groupId}-r${round + 1}-m${pairIndex + 1}`,
          stageId: "groups",
          poolId: groupId,
          round: round + 1,
          order: matches.length + 1,
          purpose: "pool",
          home: { type: "entry_seed", seed: homeSeed },
          away: { type: "entry_seed", seed: awaySeed },
        });
      }
    }
  }
  return {
    stage: {
      id: "groups",
      label: "Group stage",
      kind: "group",
      order: 1,
      groupIds,
      groupSize,
      outputRanks: groupSize,
      matchIds: matches.map((match) => match.id),
    },
    matches,
    nextOrder: matches.length + 1,
  };
}

export function createRoundRobinFormatGraph(entryCount: number): FormatGraph {
  if (!Number.isInteger(entryCount) || entryCount < 2) {
    throw new Error("Round robin requires an entry count of at least two");
  }
  const rounds = circlePairs(entryCount);
  const matches: FormatGraphMatch[] = [];
  rounds.forEach((pairs, roundIndex) =>
    pairs.forEach(([homeIndex, awayIndex], matchIndex) => {
      matches.push({
        id: `round-robin-r${roundIndex + 1}-m${matchIndex + 1}`,
        stageId: "round-robin",
        round: roundIndex + 1,
        order: matches.length + 1,
        purpose: "pool" as const,
        home: { type: "entry_seed" as const, seed: homeIndex + 1 },
        away: { type: "entry_seed" as const, seed: awayIndex + 1 },
      });
    }),
  );
  const graph: FormatGraph = {
    id: `round-robin-${entryCount}`,
    schemaVersion: 1,
    entryCount,
    stages: [
      {
        id: "round-robin",
        label: "Round robin",
        kind: "round_robin",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: entryCount,
        matchIds: matches.map((match) => match.id),
      },
    ],
    matches,
    terminalMatchIds: [],
  };
  assertValidFormatGraph(graph);
  return freezeDeep(graph) as FormatGraph;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function buildEliminationStage(
  stageId: string,
  label: string,
  kind: Exclude<FormatStageKind, "group" | "round_robin" | "bronze">,
  sources: readonly FormatParticipantSource[],
  stageOrder: number,
  orderStart: number,
  finalPurpose: FormatGraphMatch["purpose"],
): {
  stage: MutableStage;
  matches: FormatGraphMatch[];
  finalMatchId: string;
  semifinalMatchIds: readonly string[];
  nextOrder: number;
} {
  if (sources.length < 2) throw new Error(`${label} requires at least two participants`);
  const bracketSize = nextPowerOfTwo(sources.length);
  const firstRoundPairCount = bracketSize / 2;
  const byeCount = bracketSize - sources.length;
  const nodes: FormatParticipantSource[] = [];
  const matches: FormatGraphMatch[] = [];
  const firstRoundIds: string[] = [];
  let sourceIndex = 0;
  let round = 1;
  for (let pairIndex = 0; pairIndex < firstRoundPairCount; pairIndex += 1) {
    if (pairIndex < byeCount) {
      const source = sources[sourceIndex++];
      if (source) nodes.push(source);
      continue;
    }
    const home = sources[sourceIndex++];
    const away = sources[sourceIndex++];
    if (!home || !away) throw new Error(`Unable to seed ${label}`);
    const id = `${stageId}-r${round}-m${pairIndex - byeCount + 1}`;
    matches.push({
      id,
      stageId,
      round,
      order: orderStart + matches.length,
      purpose: "progression",
      home,
      away,
    });
    firstRoundIds.push(id);
    nodes.push({ type: "winner", matchId: id });
  }
  let current = nodes;
  let penultimateRoundIds: string[] = sources.length === 4 ? firstRoundIds : [];
  while (current.length > 1) {
    round += 1;
    const next: FormatParticipantSource[] = [];
    const roundIds: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const home = current[index];
      const away = current[index + 1];
      if (!home || !away) throw new Error(`Unpaired advancement slot in ${label}`);
      const id = `${stageId}-r${round}-m${index / 2 + 1}`;
      matches.push({
        id,
        stageId,
        round,
        order: orderStart + matches.length,
        purpose: current.length === 2 ? finalPurpose : "progression",
        home,
        away,
      });
      roundIds.push(id);
      next.push({ type: "winner", matchId: id });
    }
    if (current.length === 4) penultimateRoundIds = roundIds;
    current = next;
  }
  const finalMatchId = matches.at(-1)?.id;
  if (!finalMatchId) throw new Error(`${label} did not create a final`);
  return {
    stage: {
      id: stageId,
      label,
      kind,
      order: stageOrder,
      groupIds: [],
      groupSize: null,
      outputRanks: sources.length,
      matchIds: matches.map((match) => match.id),
    },
    matches,
    finalMatchId,
    semifinalMatchIds: penultimateRoundIds,
    nextOrder: orderStart + matches.length,
  };
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function buildFullPlacementGraph(entryCount: DefaultFormatEntryCount): FormatGraph {
  const group = buildGroupStage(entryCount, 4);
  const stages: MutableStage[] = [group.stage];
  const matches: FormatGraphMatch[] = [...group.matches];
  const terminals: string[] = [];
  let nextOrder = group.nextOrder;
  let stageOrder = 2;
  const groupIds = group.stage.groupIds;

  const championshipSources = [1, 2].flatMap((rank) =>
    groupIds.map((groupId): FormatParticipantSource => ({ type: "stage_rank", stageId: "groups", groupId, rank })),
  );
  const championship = buildEliminationStage(
    "championship",
    "Championship",
    "single_elimination",
    championshipSources,
    stageOrder++,
    nextOrder,
    "championship",
  );
  stages.push(championship.stage);
  matches.push(...championship.matches);
  terminals.push(championship.finalMatchId);
  nextOrder = championship.nextOrder;

  if (championship.semifinalMatchIds.length === 2) {
    const [homeSemi, awaySemi] = championship.semifinalMatchIds;
    if (!homeSemi || !awaySemi) throw new Error("Championship semifinals are incomplete");
    const bronzeId = "bronze-final";
    const bronzeMatch: FormatGraphMatch = {
      id: bronzeId,
      stageId: "bronze",
      round: 1,
      order: nextOrder++,
      purpose: "classification",
      home: { type: "loser", matchId: homeSemi },
      away: { type: "loser", matchId: awaySemi },
    };
    stages.push({
      id: "bronze",
      label: "Third place",
      kind: "bronze",
      order: stageOrder++,
      groupIds: [],
      groupSize: null,
      outputRanks: 2,
      matchIds: [bronzeId],
    });
    matches.push(bronzeMatch);
    terminals.push(bronzeId);
  }

  const secondary = [
    { rank: 3, id: "placement", label: "Placement", kind: "placement" as const },
    { rank: 4, id: "consolation", label: "Consolation", kind: "consolation" as const },
  ];
  for (const definition of secondary) {
    const sources = groupIds.map((groupId): FormatParticipantSource => ({
      type: "stage_rank",
      stageId: "groups",
      groupId,
      rank: definition.rank,
    }));
    const bracket = buildEliminationStage(
      definition.id,
      definition.label,
      definition.kind,
      sources,
      stageOrder++,
      nextOrder,
      "placement",
    );
    stages.push(bracket.stage);
    matches.push(...bracket.matches);
    terminals.push(bracket.finalMatchId);
    nextOrder = bracket.nextOrder;
  }

  const graph: FormatGraph = {
    id: `default-${entryCount}-full-placement`,
    schemaVersion: 1,
    entryCount,
    stages,
    matches,
    terminalMatchIds: terminals,
  };
  assertValidFormatGraph(graph);
  return freezeDeep(graph) as FormatGraph;
}

function buildChampionshipFocusGraph(entryCount: DefaultFormatEntryCount): FormatGraph {
  const full = buildFullPlacementGraph(entryCount);
  const retainedStages = full.stages.filter(
    (stage) => stage.id === "groups" || stage.id === "championship" || stage.id === "bronze",
  );
  const retainedIds = new Set(retainedStages.flatMap((stage) => stage.matchIds));
  const graph: FormatGraph = {
    ...full,
    id: `default-${entryCount}-championship-focus`,
    stages: retainedStages,
    matches: full.matches.filter((match) => retainedIds.has(match.id)),
    terminalMatchIds: full.terminalMatchIds.filter((id) => retainedIds.has(id)),
  };
  assertValidFormatGraph(graph);
  return freezeDeep(graph) as FormatGraph;
}

function buildCompactKnockoutGraph(entryCount: DefaultFormatEntryCount): FormatGraph {
  const sources = Array.from({ length: entryCount }, (_, index): FormatParticipantSource => ({
    type: "entry_seed",
    seed: index + 1,
  }));
  const bracket = buildEliminationStage(
    "championship",
    "Championship",
    "single_elimination",
    sources,
    1,
    1,
    "championship",
  );
  const stages: MutableStage[] = [bracket.stage];
  const matches: FormatGraphMatch[] = [...bracket.matches];
  const terminals = [bracket.finalMatchId];
  if (bracket.semifinalMatchIds.length === 2) {
    const [homeSemi, awaySemi] = bracket.semifinalMatchIds;
    if (!homeSemi || !awaySemi) throw new Error("Championship semifinals are incomplete");
    const bronzeId = "bronze-final";
    stages.push({
      id: "bronze",
      label: "Third place",
      kind: "bronze",
      order: 2,
      groupIds: [],
      groupSize: null,
      outputRanks: 2,
      matchIds: [bronzeId],
    });
    matches.push({
      id: bronzeId,
      stageId: "bronze",
      round: 1,
      order: bracket.nextOrder,
      purpose: "classification",
      home: { type: "loser", matchId: homeSemi },
      away: { type: "loser", matchId: awaySemi },
    });
    terminals.push(bronzeId);
  }
  const graph: FormatGraph = {
    id: `default-${entryCount}-compact-knockout`,
    schemaVersion: 1,
    entryCount,
    stages,
    matches,
    terminalMatchIds: terminals,
  };
  assertValidFormatGraph(graph);
  return freezeDeep(graph) as FormatGraph;
}

export function calculateFormatMetrics(graph: FormatGraph): FormatMetrics {
  assertValidFormatGraph(graph);
  const outcomeConsumers = new Map<string, string>();
  for (const match of graph.matches) {
    for (const source of [match.home, match.away]) {
      if (source.type === "winner" || source.type === "loser") {
        outcomeConsumers.set(`${source.type}:${source.matchId}`, match.id);
      }
    }
  }
  const matchesById = new Map(graph.matches.map((match) => [match.id, match]));
  const memo = new Map<string, { minimum: number; maximum: number }>();
  const boundsFromMatch = (matchId: string): { minimum: number; maximum: number } => {
    const cached = memo.get(matchId);
    if (cached) return cached;
    const outcomes = (["winner", "loser"] as const).map((outcome) => {
      const consumer = outcomeConsumers.get(`${outcome}:${matchId}`);
      return consumer ? boundsFromMatch(consumer) : { minimum: 0, maximum: 0 };
    });
    const bounds = {
      minimum: 1 + Math.min(...outcomes.map((item) => item.minimum)),
      maximum: 1 + Math.max(...outcomes.map((item) => item.maximum)),
    };
    memo.set(matchId, bounds);
    return bounds;
  };
  const leafConsumer = new Map<string, string>();
  for (const match of graph.matches) {
    const stage = graph.stages.find((candidate) => candidate.id === match.stageId);
    if (stage?.kind === "group" || stage?.kind === "round_robin") continue;
    leafConsumer.set(sourceKey(match.home), match.id);
    leafConsumer.set(sourceKey(match.away), match.id);
  }
  const participantBounds: { minimum: number; maximum: number }[] = [];
  const groupStage = graph.stages.find((stage) => stage.kind === "group");
  if (groupStage?.groupSize) {
    for (const groupId of groupStage.groupIds) {
      const actualPoolCounts = new Map<number, number>();
      for (const match of graph.matches.filter(
        (candidate) => candidate.stageId === groupStage.id && candidate.poolId === groupId,
      )) {
        for (const source of [match.home, match.away]) {
          if (source.type === "entry_seed") {
            actualPoolCounts.set(source.seed, (actualPoolCounts.get(source.seed) ?? 0) + 1);
          }
        }
      }
      const poolMatches = Math.min(...actualPoolCounts.values());
      for (let rank = 1; rank <= groupStage.outputRanks; rank += 1) {
        const consumer = leafConsumer.get(`rank:${groupStage.id}:${groupId}:${rank}`);
        const progression = consumer ? boundsFromMatch(consumer) : { minimum: 0, maximum: 0 };
        participantBounds.push({
          minimum: poolMatches + progression.minimum,
          maximum: poolMatches + progression.maximum,
        });
      }
    }
  } else {
    const roundRobin = graph.stages.find((stage) => stage.kind === "round_robin");
    if (roundRobin) {
      const actualPoolCounts = new Map<number, number>();
      for (const match of graph.matches.filter((candidate) => candidate.stageId === roundRobin.id)) {
        for (const source of [match.home, match.away]) {
          if (source.type === "entry_seed") {
            actualPoolCounts.set(source.seed, (actualPoolCounts.get(source.seed) ?? 0) + 1);
          }
        }
      }
      const poolMatches = Math.min(...actualPoolCounts.values());
      for (let rank = 1; rank <= roundRobin.outputRanks; rank += 1) {
        const consumer = leafConsumer.get(`rank:${roundRobin.id}:*:${rank}`);
        const progression = consumer ? boundsFromMatch(consumer) : { minimum: 0, maximum: 0 };
        participantBounds.push({
          minimum: poolMatches + progression.minimum,
          maximum: poolMatches + progression.maximum,
        });
      }
    } else {
      for (let seed = 1; seed <= graph.entryCount; seed += 1) {
        const consumer = leafConsumer.get(`seed:${seed}`);
        participantBounds.push(consumer ? boundsFromMatch(consumer) : { minimum: 0, maximum: 0 });
      }
    }
  }
  // Keep the map authoritative and make accidental missing match references
  // impossible to hide behind the participation calculation.
  for (const matchId of memo.keys()) {
    if (!matchesById.has(matchId)) throw new Error(`Unknown match ${matchId}`);
  }
  const guaranteedMatches = Math.min(...participantBounds.map((item) => item.minimum));
  const maximumMatches = Math.max(...participantBounds.map((item) => item.maximum));
  return { matchCount: graph.matches.length, guaranteedMatches, maximumMatches };
}

export function createDefaultFormatTemplates(entryCount: DefaultFormatEntryCount): readonly FormatTemplate[] {
  if (!defaultFormatEntryCounts.includes(entryCount)) throw new Error(`No default templates for ${entryCount} entries`);
  const definitions: readonly {
    strategy: FormatTemplateStrategy;
    label: string;
    advantage: string;
    graph: FormatGraph;
  }[] = [
    {
      strategy: "full_placement",
      label: "Full placement",
      advantage: "Every entry gets a classification path after group play.",
      graph: buildFullPlacementGraph(entryCount),
    },
    {
      strategy: "championship_focus",
      label: "Championship focus",
      advantage: "Group play stays complete while the finals programme is shorter.",
      graph: buildChampionshipFocusGraph(entryCount),
    },
    {
      strategy: "compact_knockout",
      label: "Compact knockout",
      advantage: "Uses the fewest match slots and reaches a winner quickly.",
      graph: buildCompactKnockoutGraph(entryCount),
    },
  ];
  return freezeDeep(
    definitions.map((definition) => ({
      id: `${entryCount}-${definition.strategy}`,
      label: definition.label,
      strategy: definition.strategy,
      advantage: definition.advantage,
      graph: definition.graph,
      metrics: calculateFormatMetrics(definition.graph),
    })),
  ) as readonly FormatTemplate[];
}

export function getDefaultFormatTemplate(entryCount: DefaultFormatEntryCount): FormatTemplate {
  const template = createDefaultFormatTemplates(entryCount).find(
    (candidate) => candidate.strategy === "full_placement",
  );
  if (!template) throw new Error(`No default template for ${entryCount} entries`);
  return template;
}

export function recommendFormats(request: FormatRecommendationRequest): readonly FormatRecommendation[] {
  if (!Number.isInteger(request.availableMatchSlots) || request.availableMatchSlots < 0) {
    throw new Error("Available match slots must be a non-negative integer");
  }
  if (!defaultFormatEntryCounts.includes(request.entryCount as DefaultFormatEntryCount)) {
    return [];
  }
  const minimumGuaranteedMatches = request.minimumGuaranteedMatches ?? 1;
  if (!Number.isInteger(minimumGuaranteedMatches) || minimumGuaranteedMatches < 1) {
    throw new Error("Minimum guaranteed matches must be a positive integer");
  }
  if (
    request.maximumMatchCount !== undefined &&
    (!Number.isInteger(request.maximumMatchCount) || request.maximumMatchCount < 1)
  ) {
    throw new Error("Maximum match count must be a positive integer");
  }
  const templates = createDefaultFormatTemplates(request.entryCount as DefaultFormatEntryCount);
  const scored = templates.map((template) => {
    const reasons: string[] = [];
    if (template.metrics.matchCount > request.availableMatchSlots) reasons.push("insufficient_capacity");
    if (template.metrics.guaranteedMatches < minimumGuaranteedMatches) reasons.push("minimum_matches_not_met");
    if (request.maximumMatchCount !== undefined && template.metrics.matchCount > request.maximumMatchCount) {
      reasons.push("maximum_match_count_exceeded");
    }
    return {
      template,
      feasible: reasons.length === 0,
      reasons,
      spareMatchSlots: request.availableMatchSlots - template.metrics.matchCount,
    };
  });
  scored.sort(
    (left, right) =>
      Number(right.feasible) - Number(left.feasible) ||
      (left.feasible
        ? right.template.metrics.guaranteedMatches - left.template.metrics.guaranteedMatches ||
          left.spareMatchSlots - right.spareMatchSlots
        : left.reasons.length - right.reasons.length || right.spareMatchSlots - left.spareMatchSlots) ||
      left.template.metrics.matchCount - right.template.metrics.matchCount ||
      left.template.id.localeCompare(right.template.id),
  );
  return freezeDeep(
    scored
      .filter((candidate) => candidate.feasible || request.includeInfeasible === true)
      .map((candidate, index) => ({
        rank: index + 1,
        templateId: candidate.template.id,
        label: candidate.template.label,
        advantage: candidate.template.advantage,
        feasible: candidate.feasible,
        requiredMatchSlots: candidate.template.metrics.matchCount,
        availableMatchSlots: request.availableMatchSlots,
        spareMatchSlots: candidate.spareMatchSlots,
        guaranteedMatches: candidate.template.metrics.guaranteedMatches,
        reasons: candidate.reasons,
        graph: candidate.template.graph,
      })),
  ) as readonly FormatRecommendation[];
}

/**
 * Builds competition-level alternatives only after the caller has resolved
 * exact capacity and per-division entry counts. A family applies the same
 * strategy to every division, so the displayed totals cannot hide capacity
 * consumed by another division.
 */
export function recommendCompetitionFormats(
  request: CompetitionFormatRecommendationRequest,
): CompetitionFormatRecommendationSet {
  const supportedSports = new Set(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);
  if (!supportedSports.has(request.sportCode)) throw new Error("Sport is not supported for format recommendations");
  if (!Number.isSafeInteger(request.availableMatchSlots) || request.availableMatchSlots < 0)
    throw new Error("Available match slots must be a non-negative integer");
  if (request.divisions.length === 0) throw new Error("At least one division is required");
  if (new Set(request.divisions.map((division) => division.id)).size !== request.divisions.length)
    throw new Error("Division IDs must be distinct");
  const minimumGuaranteedMatches = request.minimumGuaranteedMatches ?? 1;
  if (!Number.isSafeInteger(minimumGuaranteedMatches) || minimumGuaranteedMatches < 1)
    throw new Error("Minimum guaranteed matches must be a positive integer");

  const strategies: readonly FormatTemplateStrategy[] = ["full_placement", "championship_focus", "compact_knockout"];
  const candidates = strategies.flatMap((strategy): CompetitionFormatRecommendation[] => {
    const divisions = request.divisions.map((division) => {
      if (!defaultFormatEntryCounts.includes(division.entryCount as DefaultFormatEntryCount))
        throw new Error(`Division ${division.id} has an unsupported entry count`);
      const template = createDefaultFormatTemplates(division.entryCount as DefaultFormatEntryCount).find(
        (item) => item.strategy === strategy,
      );
      if (!template) throw new Error(`Missing ${strategy} template for division ${division.id}`);
      if (!validateFormatGraph(template.graph).valid) return null;
      return {
        divisionId: division.id,
        entryCount: division.entryCount,
        graph: template.graph,
        matchCount: template.metrics.matchCount,
        guaranteedMatches: template.metrics.guaranteedMatches,
      };
    });
    if (divisions.some((division) => division === null)) return [];
    const exactDivisions = divisions as NonNullable<(typeof divisions)[number]>[];
    const matchCount = exactDivisions.reduce((total, division) => total + division.matchCount, 0);
    const guaranteedMatches = Math.min(...exactDivisions.map((division) => division.guaranteedMatches));
    const purposes = new Set(
      exactDivisions.flatMap((division) => division.graph.matches.map((match) => match.purpose)),
    );
    const rankingCoverage = purposes.has("classification")
      ? "all_entries"
      : purposes.has("placement")
        ? "podium"
        : "champion";
    const hasKnockout = exactDivisions.every((division) =>
      division.graph.stages.some((stage) => stage.kind === "single_elimination"),
    );
    const usesCrossGroupQualification = exactDivisions.some((division) =>
      division.graph.matches.some((match) => match.home.type === "stage_rank" || match.away.type === "stage_rank"),
    );
    if (guaranteedMatches < minimumGuaranteedMatches) return [];
    if (request.rankAllEntries && rankingCoverage !== "all_entries") return [];
    if (request.placementRequired && strategy !== "full_placement") return [];
    if (request.knockoutRequired && !hasKnockout) return [];
    if (request.crossGroupAllowed === false && usesCrossGroupQualification) return [];
    const spareMatchSlots = request.availableMatchSlots - matchCount;
    const fits = spareMatchSlots >= 0;
    const tight = fits && spareMatchSlots <= Math.max(1, Math.floor(request.availableMatchSlots * 0.1));
    return [
      {
        id: `competition-${strategy}`,
        strategy,
        label:
          strategy === "full_placement"
            ? "Full placement"
            : strategy === "championship_focus"
              ? "Championship focus"
              : "Compact knockout",
        advantage:
          strategy === "full_placement"
            ? "Ranks every entry."
            : strategy === "championship_focus"
              ? "Keeps complete group play with shorter finals."
              : "Uses the fewest match slots.",
        capacityStatus: fits ? (tight ? "tight" : "fits") : "requires_changes",
        scheduleFeasibility: fits ? "not_checked" : "infeasible",
        matchCount,
        guaranteedMatches,
        rankingCoverage,
        availableMatchSlots: request.availableMatchSlots,
        spareMatchSlots,
        divisions: exactDivisions,
        warningCodes: fits ? [] : ["insufficient_capacity"],
      },
    ];
  });
  const priority = request.priority ?? "simplicity";
  const preference: Record<typeof priority, readonly FormatTemplateStrategy[]> = {
    speed: ["compact_knockout", "championship_focus", "full_placement"],
    simplicity: ["championship_focus", "compact_knockout", "full_placement"],
    participation: ["full_placement", "championship_focus", "compact_knockout"],
  };
  const order = new Map(preference[priority].map((strategy, index) => [strategy, index]));
  const sorted = [...candidates].sort(
    (left, right) =>
      (order.get(left.strategy) ?? 99) - (order.get(right.strategy) ?? 99) || left.id.localeCompare(right.id),
  );
  const recommendations = sorted.filter((candidate) => candidate.capacityStatus !== "requires_changes").slice(0, 3);
  const requiresChanges =
    sorted
      .filter((candidate) => candidate.capacityStatus === "requires_changes")
      .sort((left, right) => right.spareMatchSlots - left.spareMatchSlots || left.id.localeCompare(right.id))[0] ??
    null;
  return freezeDeep({ recommendations, requiresChanges }) as CompetitionFormatRecommendationSet;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Browser-safe synchronous SHA-256; input is already canonical UTF-8 JSON. */
function sha256(value: string): string {
  const source = new TextEncoder().encode(value);
  const byteLength = Math.ceil((source.length + 1 + 8) / 64) * 64;
  const padded = new Uint8Array(byteLength);
  padded.set(source);
  padded[source.length] = 0x80;
  const bitLength = source.length * 8;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(byteLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  paddedView.setUint32(byteLength - 4, bitLength >>> 0, false);

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = paddedView.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** Stable Phase 3 graph identity reused by Phase 4 validation and preview. */
export function createFormatGraphHash(graph: FormatGraph): string {
  assertValidFormatGraph(graph);
  return sha256(stableStringify(graph));
}

export function createFormatRevision(
  graph: FormatGraph,
  options: { readonly parent?: FormatRevision; readonly createdAt: string },
): FormatRevision {
  assertValidFormatGraph(graph);
  const createdAt = new Date(options.createdAt);
  if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== options.createdAt) {
    throw new Error("Format revision createdAt must be a canonical ISO timestamp");
  }
  if (options.parent && options.parent.formatId !== graph.id) {
    throw new Error("A format revision parent must belong to the same format");
  }
  const clonedGraph = JSON.parse(stableStringify(graph)) as FormatGraph;
  const revision: FormatRevision = {
    formatId: graph.id,
    revision: (options.parent?.revision ?? 0) + 1,
    parentRevision: options.parent?.revision ?? null,
    createdAt: options.createdAt,
    contentHash: createFormatGraphHash(clonedGraph),
    graph: clonedGraph,
  };
  return freezeDeep(revision) as FormatRevision;
}
