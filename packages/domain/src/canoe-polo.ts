export const CANOE_POLO_DEFAULT_SETTINGS = {
  version: "canoe-polo-v1",
  entryType: "team",
  periods: 2,
  scoringUnit: "goal",
  scorerRequired: true,
  allowUnknownScorer: false,
  manualPeriodAndTime: true,
  cards: ["green", "yellow", "red"],
  timeouts: true,
  incidents: true,
  liveTimer: false,
  shotClock: false,
  slotMinutes: 30,
  standingsCriteria: ["points", "goal_difference", "goals_for", "head_to_head", "discipline", "seed"],
} as const;

export type CanoePoloSettings = {
  version: string;
  entryType: "team";
  periods: 2;
  scoringUnit: "goal";
  scorerRequired: boolean;
  allowUnknownScorer: boolean;
  manualPeriodAndTime: boolean;
  cards: readonly ["green", "yellow", "red"];
  timeouts: boolean;
  incidents: boolean;
  liveTimer: false;
  shotClock: false;
  slotMinutes: number;
  standingsCriteria: readonly StandingsCriterion[];
};

export type StandingsCriterion = "points" | "goal_difference" | "goals_for" | "head_to_head" | "discipline" | "seed";

export type CompetitionEntry = {
  id: string;
  name: string;
  seed: number;
};
