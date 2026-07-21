export type SurfaceState =
  "ready" | "loading" | "empty" | "error" | "offline" | "conflict" | "read-only" | "permission";

export type OrganiserSection =
  | "control-room"
  | "setup"
  | "settings"
  | "entries"
  | "capacity"
  | "format"
  | "schedule"
  | "results"
  | "publish"
  | "access"
  | "audit";

export type MatchView = {
  id: string;
  label: string;
  stage: string;
  time: string;
  area: string;
  home: string;
  away: string;
  homeScore?: number;
  awayScore?: number;
  status: "scheduled" | "live" | "final";
};

export type StandingView = {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  difference: number;
  points: number;
};

export type CompetitionView = {
  id: string;
  slug: string;
  name: string;
  sportCode?: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
  sport: string;
  venue: string;
  timezone: string;
  dateLabel: string;
  publicationRevision: string;
  publishedAt: string;
  lastUpdated: string;
  division: { id: string; name: string; teamCount: number; matchCount: number };
  divisions?: ReadonlyArray<{ id: string; name: string }>;
  teams: string[];
  areas: string[];
  matches: MatchView[];
  standings: StandingView[];
  bracket: Array<{ round: string; fixture: string; score: string; state: string }>;
  audit: Array<{ time: string; actor: string; action: string; detail: string }>;
  scheduleRows?: ReadonlyArray<{ id: string; time: string; cells: readonly string[] }>;
  accessPasses?: ReadonlyArray<{ matchId: string; displayCode: string; expiresAt: string; scoringHref?: string }>;
  settings?: ReadonlyArray<readonly [string, string]>;
  capacityAreas?: ReadonlyArray<{ name: string; availability: string; slotCount: number | null }>;
  availableCapacity?: number | null;
  attention?: { body: string; href: string };
  publishedVersionLabel?: string;
  publicationState?: "draft" | "published";
  formatSummary?: ReadonlyArray<readonly [string, string]>;
};

export type CompetitionReadPort = {
  getBySlug(slug: string): Promise<CompetitionView | null>;
};

export type ScoringEventCommand = {
  clientEventId: string;
  matchId: string;
  eventType: string;
  team?: "home" | "away";
  scorer: string;
  period: number;
  manualTime: string;
};

export type ScoringAppendReceipt = {
  clientEventId: string;
  sequence: number;
  syncState: "acknowledged" | "pending";
};

export type ScoringAccessInput = { token: string; shortCode?: never } | { token?: never; shortCode: string };

export type ScoringSessionView = {
  competitionSlug: string;
  matchId: string;
  matchLabel: string;
  stage: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  events: ScoringEventCommand[];
  readOnly: boolean;
};

export type FinalizeResultCommand = {
  matchId: string;
  homeScore: number;
  awayScore: number;
  scorer: string;
};

export type ScoringCommandPort = {
  exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView>;
  recoverSession(): Promise<ScoringSessionView | null>;
  appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt>;
  finalizeResult(command: FinalizeResultCommand): Promise<{ receiptId: string; publishedAt: string }>;
};

export const organiserSections: ReadonlyArray<{ id: OrganiserSection; label: string; short: string }> = [
  { id: "control-room", label: "Control room", short: "Overview" },
  { id: "setup", label: "Competition setup", short: "Setup" },
  { id: "settings", label: "Game settings", short: "Settings" },
  { id: "entries", label: "Entries and divisions", short: "Entries" },
  { id: "capacity", label: "Capacity", short: "Capacity" },
  { id: "format", label: "Competition format", short: "Format" },
  { id: "schedule", label: "Schedule", short: "Schedule" },
  { id: "results", label: "Standings and advancement", short: "Results" },
  { id: "publish", label: "Publication", short: "Publish" },
  { id: "access", label: "Scoring access", short: "Access" },
  { id: "audit", label: "Audit log", short: "Audit" },
];

export const phase2Copy = {
  logoMark: "M",
  brand: "MATCHDAY",
  skip: "Skip to workspace",
  organiserNav: "Competition workspace",
  backHome: "Back to MATCHDAY",
  competitionContext: "Singapore Open 2026",
  draftSynced: "Draft synced 18 seconds ago",
  currentRevision: "Schedule revision 4",
  save: "Save changes",
  continue: "Continue",
  edit: "Edit",
  publish: "Publish competition",
  published: "Published",
  openPublic: "Open public page",
  setupTitle: "Competition setup",
  setupIntro: "Confirm the event identity before building its division and match plan.",
  settingsTitle: "Game and competition settings",
  settingsIntro: "Scoring and standings settings are pinned to this competition and versioned with its format.",
  entriesTitle: "Entries and divisions",
  entriesIntro: "Manage confirmed and placeholder entries before selecting a format.",
  capacityTitle: "Capacity",
  capacityIntro: "Continuous availability is calculated per playing area. Break remnants are never combined.",
  formatTitle: "Competition format",
  formatIntro: "Build or select the stage graph that will generate authoritative matches.",
  scheduleTitle: "Schedule",
  scheduleIntro: "Time slots respect area availability, organiser constraints and match dependencies.",
  resultsTitle: "Standings and advancement",
  resultsIntro: "Results recalculate deterministic standings and future participants.",
  publishTitle: "Publication",
  publishIntro: "Public results and schedule revisions remain separate publication streams.",
  accessTitle: "Scoring access",
  accessIntro: "Match-scoped access never reveals the underlying credential.",
  auditTitle: "Audit log",
  auditIntro: "Security-sensitive and competition-authoritative changes remain attributable.",
  errorTitle: "Competition workspace unavailable",
  errorBody: "The organiser API could not return a valid competition workspace.",
} as const;
