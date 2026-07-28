import type { SportId, SportPackSettings } from "@matchday/domain";

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
  divisions?: ReadonlyArray<{
    id: string;
    name: string;
    entryLimit?: number;
    entries?: ReadonlyArray<{ id: string; name: string; seed: number | null; status: string }>;
  }>;
  teams: string[];
  areas: string[];
  matches: MatchView[];
  standings: StandingView[];
  bracket: Array<{ round: string; fixture: string; score: string; state: string }>;
  audit: Array<{ time: string; actor: string; action: string; detail: string }>;
  scheduleRows?: ReadonlyArray<{ id: string; time: string; cells: readonly string[] }>;
  accessPasses?: ReadonlyArray<{
    id: string;
    matchId: string;
    role: "viewer" | "scorekeeper";
    displayCode: string;
    expiresAt: string;
    revoked: boolean;
    status: "active" | "expired" | "revoked";
    fallbackCodeStatus?: "available" | "rotation_required" | "unavailable";
  }>;
  settings?: ReadonlyArray<readonly [string, string]>;
  capacityAreas?: ReadonlyArray<{ name: string; availability: string; slotCount: number | null }>;
  availableCapacity?: number | null;
  attention?: { body: string; href: string };
  publishedVersionLabel?: string;
  publicationState?: "draft" | "published";
  formatSummary?: ReadonlyArray<readonly [string, string]>;
  canEdit?: boolean;
};

export type CompetitionReadPort = {
  getBySlug(slug: string): Promise<CompetitionView | null>;
};

export type ScoringEventCommand = {
  clientEventId: string;
  expectedSequence: number;
  matchId: string;
  eventType: string;
  canonical: true;
  team?: "home" | "away";
  scorer: string;
  period: number;
  manualTime: string;
  participantId?: string | null;
  unknownParticipant?: boolean;
  segmentNumber?: number;
  manualTimeSeconds?: number | null;
  reversalTargetEventId?: string;
  reason?: string;
  occurredAt?: string;
};

export type ScoringAppendReceipt = {
  clientEventId: string;
  sequence: number;
  syncState: "acknowledged" | "pending";
};

export type ScoringDeviceView = { id: string; label: string };

export type ScoringAccessInput =
  | { token: string; shortCode?: never; device: ScoringDeviceView }
  | { token?: never; shortCode: string; device: ScoringDeviceView };

export type ScoringAccessMode = "writer" | "candidate" | "viewer" | "transferred";

export type ScoringCanonicalActionView = {
  eventId: string;
  clientEventId: string;
  eventType: string;
  label: string;
  side: "home" | "away" | null;
  participantId: string | null;
  segmentNumber: number;
  scoreDelta: number;
  occurredAt: string;
  reversed: boolean;
  reversible: boolean;
};

export type ScoringSegmentView = {
  number: number;
  home: number;
  away: number;
  completed: boolean;
  winner: "home" | "away" | null;
};

export type ScoringScoreStateView = {
  home: number;
  away: number;
  lifecycle: "not_started" | "in_progress" | "finalised";
  currentSegment: number;
  totalPoints: Readonly<Record<"home" | "away", number>>;
  segmentWins: Readonly<Record<"home" | "away", number>>;
  segments: ScoringSegmentView[];
  actions: ScoringCanonicalActionView[];
  conflicts: ReadonlyArray<{ code: string; segmentNumber: number; targetEventId: string }>;
};

export type ScoringSessionView = {
  competitionSlug: string;
  sportId: SportId;
  sportPackVersion: string;
  sportSettings: SportPackSettings;
  matchId: string;
  matchLabel: string;
  stage: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  scoreState: ScoringScoreStateView;
  events: ScoringEventCommand[];
  throughSequence: number;
  mode: ScoringAccessMode;
  permissions: string[];
  generation: number | null;
  leaseExpiresAt: string | null;
  expiresAt: string;
  takeoverStatus: "none" | "pending" | "approved" | "denied";
  readOnly: boolean;
};

export type FinalizeResultCommand = {
  matchId: string;
  expectedSequence: number;
  homeScore: number;
  awayScore: number;
  scorer: string;
};

export type ScoringCommandPort = {
  exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView>;
  recoverSession(signal?: AbortSignal): Promise<ScoringSessionView | null>;
  heartbeat(
    input: {
      lastAcknowledgedSequence: number;
      pendingEventCount: number;
      pendingThroughSequence: number | null;
    },
    signal?: AbortSignal,
  ): Promise<ScoringSessionView>;
  requestTakeover(input: {
    pendingEventCount: number;
    pendingThroughSequence: number | null;
  }): Promise<{ status: "pending"; requestId: string }>;
  appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt>;
  finalizeResult(command: FinalizeResultCommand): Promise<{ receiptId: string; publishedAt: string }>;
};

export const organiserSections: ReadonlyArray<{ id: OrganiserSection; label: string; short: string }> = [
  { id: "control-room", label: "Control room", short: "Overview" },
  { id: "setup", label: "Competition setup", short: "Setup" },
  { id: "settings", label: "Canoe Polo rules", short: "Rules" },
  { id: "entries", label: "Teams and division", short: "Entries" },
  { id: "capacity", label: "Capacity", short: "Capacity" },
  { id: "format", label: "Group to knockout", short: "Format" },
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
  settingsTitle: "Canoe Polo rules",
  settingsIntro: "Rules are fixed for this division and versioned with its format.",
  entriesTitle: "Teams and division",
  entriesIntro: "Eight confirmed teams feed two balanced groups of four.",
  capacityTitle: "Capacity",
  capacityIntro: "Continuous availability is calculated per playing area. Break remnants are never combined.",
  formatTitle: "Group to knockout",
  formatIntro: "Two groups advance into semi-finals, a bronze match and the final.",
  scheduleTitle: "Schedule",
  scheduleIntro: "Thirty-minute slots respect area availability, rest and knockout dependencies.",
  resultsTitle: "Standings and advancement",
  resultsIntro: "Server-calculated tables and qualifier decisions from persisted final results.",
  publishTitle: "Publication",
  publishIntro: "Published revisions are immutable. Create a new revision to change public information.",
  accessTitle: "Scoring access",
  accessIntro: "Each access pass is match-scoped, revocable and limited to one active writer.",
  auditTitle: "Audit log",
  auditIntro: "Every scheduling, scoring and publication change is attributed and time ordered.",
  controlTitle: "Event-day control room",
  controlIntro: "One operational view of the live result, next decisions and publication health.",
  attention: "Attention required",
  attentionBody: "Match 12 needs its scorer assigned before the 10:30 start.",
  resolve: "Assign scorer",
  liveNow: "Live now",
  nextMatches: "Next matches",
  readiness: "Publication readiness",
  allReady: "All required checks passed",
  publicVersion: "Public version",
  freshness: "Freshness",
  loadingTitle: "Loading competition",
  loadingBody: "Retrieving the latest saved revision and publication state.",
  emptyTitle: "Nothing here yet",
  emptyBody: "Complete the previous step to create this part of the competition.",
  errorTitle: "Competition data could not load",
  errorBody: "No changes were made. Retry when the service is available.",
  offlineTitle: "Working from the last saved revision",
  offlineBody: "Editing is paused while offline. Public results remain available from the last publication.",
  conflictTitle: "A newer revision is available",
  conflictBody: "Review the newer version before continuing so another organiser's work is not overwritten.",
  readOnlyTitle: "This revision is read only",
  readOnlyBody: "Published revisions cannot be edited. Create a draft revision to make changes.",
  permissionTitle: "You do not have access to this section",
  permissionBody: "Ask an organisation administrator for the competition manager role.",
  retry: "Retry",
  reviewRevision: "Review revision",
  createRevision: "Create draft revision",
  requestAccess: "Request access",
  team: "Team",
  played: "P",
  won: "W",
  drawn: "D",
  lost: "L",
  difference: "GD",
  points: "Pts",
  publicTitleSuffix: "Canoe Polo",
  publicLive: "Live",
  publicFinal: "Final",
  publicScheduled: "Scheduled",
  results: "Results",
  table: "Table",
  bracket: "Bracket",
  schedule: "Schedule",
  updated: "Updated 18 seconds ago",
  publishedVersion: "Published revision 4",
  refreshNote: "Results update automatically. Schedule times appear only from the published schedule.",
  scoringAccess: "Match scoring access",
  validateAccess: "Validate access",
  codeLabel: "Scoring code",
  codeHint: "Use the match-specific code from the organiser.",
  codeError: "That scoring code is not valid for this match.",
  confirmMatch: "I am at Match 12 and ready to score this fixture.",
  startScoring: "Start scoring",
  scorerLabel: "Scorer name",
  scorerHint: "Required on every scoring event for audit attribution.",
  scorerMissing: "Enter the scorer name before recording an event.",
  matchTwelve: "Match 12",
  groupB: "Group B",
  periodLabel: "Period",
  eventTimeLabel: "Event time",
  firstPeriod: "Period 1",
  secondPeriod: "Period 2",
  goal: "Goal",
  card: "Card",
  timeout: "Timeout",
  incident: "Incident",
  greenCard: "Green card",
  yellowCard: "Yellow card",
  redCard: "Red card",
  addIncident: "Add incident",
  marinaBlue: "Marina Blue",
  harbourGold: "Harbour Gold",
  writerActive: "Active scorer",
  synced: "Synced",
  readOnly: "Read only",
  candidate: "Waiting for takeover",
  candidateBody: "You can review the match, but only the active scorer can record events.",
  transferred: "Scoring moved to another device",
  transferredBody: "Your previous entries remain visible. This device can no longer change the match.",
  checkingAccess: "Checking scoring access",
  takeoverRequested: "Takeover requested",
  requestTakeover: "Request scoring access",
  sessionExpired: "This scoring session has expired",
  sessionRevoked: "This scoring access was revoked",
  rateLimited: "Too many access attempts. Wait before trying again.",
  accessRestored: "Authoritative scoring access restored.",
  leaseExpiring: "Writer lease needs reconnection",
  leaseExpiringBody:
    "Scoring is read only because the 45-second writer lease is near or past its deadline. Your scoring session and access pass remain valid while authoritative access is checked.",
  syncPending: "1 event pending sync",
  writerConflict: "Another device is the active scorer",
  writerConflictBody:
    "Scoring controls are locked. An organiser must confirm a takeover before new events can be recorded.",
  reviewFinal: "Review final score",
  finalise: "Confirm final result",
  finalReceipt: "Result publication acknowledged",
  finalReceiptBody: "Final result R-2026-09-12-M12-04 was accepted and published at 10:24 SGT.",
  finalReviewBody: "Confirm this score to publish the result and refresh the public competition view.",
  serviceUnavailable:
    "Scoring access could not be verified. Check the code or try again when the service is available.",
  semanticRejected: "This action is not valid for the current match state. Review the details and try again.",
  eventLog: "Match events",
  noEvents: "No events recorded",
  scorer: "Scorer",
  manualTime: "Manual match time",
  periodRequired: "Choose a period and event time before recording an event.",
  qrUnavailable: "This access pass has expired",
  qrUnavailableBody: "Ask the organiser to issue a new match-scoped pass.",
  competitionName: "Competition name",
  sport: "Sport",
  timezone: "Timezone",
  venue: "Venue",
  dates: "Dates",
  periods: "Periods",
  periodLength: "Period length",
  tenMinutes: "10 minutes",
  matchSlot: "Match slot",
  thirtyMinutes: "30 minutes",
  pointsRule: "Points",
  pointsRuleValue: "Win 3 · Draw 1 · Loss 0",
  tieBreakOrder: "Tie-break order",
  tieBreakValue: "Goal difference · Goals for · Head-to-head · Discipline",
  matchControls: "Match controls",
  matchControlsValue: "Manual period and event time",
  confirmed: "Confirmed",
  playingAreas: "Playing areas",
  continuousSlots: "10 continuous slots",
  slots: "slots",
  availableCapacity: "Available capacity",
  requiredSlots: "16 required match slots",
  requiredMatchSlots: "required match slots",
  slotsRemain: "slots remain",
  remainingSlots: "4 slots remain. Separate break remnants were excluded.",
  groupA: "Group A",
  fourTeamsSixMatches: "4 teams · 6 matches",
  semiFinals: "Semi-finals",
  topTwo: "Top 2 from each group",
  bronzeMatch: "Bronze match",
  losers: "Losers",
  final: "Final",
  winners: "Winners",
  time: "Time",
  publishedLabel: "Published",
  immediate: "Immediate",
  revisionFour: "Revision 4",
  notPublished: "Not published",
  formatRevision: "Format revision",
  groups: "Groups",
  knockoutStages: "Knockout stages",
  matchesLabel: "Matches",
  notConfigured: "Not configured",
  accessPasses: "Match-scoped passes",
  accessPassesBody: "Only the hash is stored. Each pass expires after its scoring window.",
  issuePass: "Issue pass",
  expires: "Expires",
  openScoringPrefix: "Open scoring for",
  versus: "vs",
  courtTwoStart: "10:00 · Court 2",
  scheduleRevisionCode: "sch_04",
  periodPrefix: "P",
  confirmGoalTitle: "Confirm goal",
  confirmGoalBody: "Review the team, scorer attribution and match time before appending this event.",
  selectedTeam: "Selected team",
  eventDetails: "Event details",
  cancel: "Cancel",
  recordGoalFor: "Record goal for",
  goalSheetScorerHint: "This name is attached to the goal event and audit record.",
  scoreControlsTitle: "Scoring controls",
  scoreControlsReadOnly: "Only the active scoring device can record match events.",
  scoreControlsPending: "Saving the match event…",
  manualTimeOnly: "Enter event times manually. No live match clock is running.",
  scoreGroup: "Score",
  segmentGroup: "Segment",
  operationalGroup: "Match actions",
  exceptionalGroup: "Exceptional result",
  participantLabel: "Scorer or participant name",
  participantRequired: "Enter the participant or player before recording this event.",
  participantHint: "Required only when this sport action needs participant attribution.",
  unknownParticipant: "Scorer is currently unknown",
  unknownParticipantHint: "This creates an explicit cleanup item; it does not silently omit attribution.",
  segmentLabel: "Segment",
  actionDialogBody: "Review the event details before appending this canonical match event.",
  recordEvent: "Record event",
  eventRecorded: "Match event recorded.",
  recentCanonicalEvents: "Recent canonical events",
  reverseEvent: "Reverse event",
  reversalTitle: "Reverse recorded event",
  reversalBody: "The original event remains in the audit timeline. Add a reason for this reversal.",
  reversalReason: "Reversal reason",
  reversalReasonHint: "Enter at least 3 characters.",
  confirmReversal: "Confirm reversal",
  eventReversed: "Match event reversed.",
  reversed: "Reversed",
  finalisationSummary: "Finalisation summary",
  matchLifecycle: "Match state",
  currentSegment: "Current segment",
  segmentWins: "Segments won",
  totalPoints: "Total points",
  recordedActions: "Recorded actions",
  noLiveClock: "No live clock",
} as const;

export const phase2Machine = {
  controlRoom: "control-room" as const,
  ready: "ready" as const,
  loading: "loading" as const,
  empty: "empty" as const,
  active: "active" as const,
  candidate: "candidate" as const,
  checking: "checking" as const,
  conflict: "conflict" as const,
  expired: "expired" as const,
  expiring: "expiring" as const,
  rateLimited: "rate-limited" as const,
  readOnly: "read-only" as const,
  revoked: "revoked" as const,
  transferred: "transferred" as const,
  writer: "writer" as const,
  access: "access" as const,
  goal: "goal",
  home: "home" as const,
  away: "away" as const,
  greenCard: "green card",
  yellowCard: "yellow card",
  redCard: "red card",
  timeout: "timeout",
  incident: "incident",
  matchStarted: "match_started",
  overtime: "overtime",
  reversal: "reversal",
  notStarted: "not_started" as const,
  canoePolo: "canoe_polo" as const,
  scrollNearest: "nearest" as const,
  matchTwelveId: "M12",
  singaporeOpenSlug: "singapore-open",
  scoringApiMode: "api" as const,
  scoringDemoMode: "demo" as const,
};

export const canoePoloSettings: ReadonlyArray<readonly [string, string]> = [
  [phase2Copy.periods, "2"],
  [phase2Copy.periodLength, phase2Copy.tenMinutes],
  [phase2Copy.matchSlot, phase2Copy.thirtyMinutes],
  [phase2Copy.pointsRule, phase2Copy.pointsRuleValue],
  [phase2Copy.tieBreakOrder, phase2Copy.tieBreakValue],
  [phase2Copy.matchControls, phase2Copy.matchControlsValue],
];

export const phase2ScheduleGrid: ReadonlyArray<readonly [string, string, string]> = [
  ["10:00", "M11 · Group A", "M12 · Group B"],
  ["10:30", "M13 · Semi-final", "M14 · Semi-final"],
  ["11:00", "Rest window", "Rest window"],
  ["12:00", "M15 · Bronze", "Available"],
  ["12:30", "M16 · Final", "Available"],
];

export const phase2Competition: CompetitionView = {
  id: "cmp_sgopen_2026",
  slug: "singapore-open",
  name: "Singapore Open 2026",
  sportCode: "canoe_polo",
  sport: "Canoe Polo",
  venue: "Marina Reservoir",
  timezone: "Asia/Singapore",
  dateLabel: "12–13 September 2026",
  publicationRevision: "pub_04",
  publishedAt: "12 Sep, 09:40 SGT",
  lastUpdated: "12 Sep, 10:24 SGT",
  division: { id: "open", name: "Open division", teamCount: 8, matchCount: 16 },
  divisions: [
    { id: "open", name: "Open division" },
    { id: "women", name: "Women's division" },
  ],
  teams: [
    "Marina Blue",
    "Harbour Gold",
    "Kallang Current",
    "Seletar North",
    "Punggol Wake",
    "Sentosa Tide",
    "Pasir Ris Rapids",
    "East Coast Oars",
  ],
  areas: ["Court 1", "Court 2"],
  matches: [
    {
      id: "M12",
      label: "Match 12",
      stage: "Group B",
      time: "10:00",
      area: "Court 2",
      home: "Marina Blue",
      away: "Harbour Gold",
      homeScore: 4,
      awayScore: 3,
      status: "final",
    },
    {
      id: "M13",
      label: "Match 13",
      stage: "Semi-final",
      time: "10:30",
      area: "Court 1",
      home: "Kallang Current",
      away: "Punggol Wake",
      homeScore: 2,
      awayScore: 1,
      status: "live",
    },
    {
      id: "M14",
      label: "Match 14",
      stage: "Semi-final",
      time: "10:30",
      area: "Court 2",
      home: "Marina Blue",
      away: "Sentosa Tide",
      status: "scheduled",
    },
    {
      id: "M15",
      label: "Match 15",
      stage: "Bronze match",
      time: "12:00",
      area: "Court 1",
      home: "Loser M13",
      away: "Loser M14",
      status: "scheduled",
    },
    {
      id: "M16",
      label: "Match 16",
      stage: "Final",
      time: "12:30",
      area: "Court 1",
      home: "Winner M13",
      away: "Winner M14",
      status: "scheduled",
    },
  ],
  standings: [
    { position: 1, team: "Marina Blue", played: 3, won: 3, drawn: 0, lost: 0, difference: 6, points: 9 },
    { position: 2, team: "Harbour Gold", played: 3, won: 2, drawn: 0, lost: 1, difference: 3, points: 6 },
    { position: 3, team: "Seletar North", played: 3, won: 1, drawn: 0, lost: 2, difference: -2, points: 3 },
    { position: 4, team: "East Coast Oars", played: 3, won: 0, drawn: 0, lost: 3, difference: -7, points: 0 },
  ],
  bracket: [
    { round: "Semi-final", fixture: "Kallang Current · Punggol Wake", score: "2–1", state: "Live · P2 04:12" },
    { round: "Semi-final", fixture: "Marina Blue · Sentosa Tide", score: "–", state: "10:30 · Court 2" },
    { round: "Final", fixture: "Winner M13 · Winner M14", score: "–", state: "12:30 · Court 1" },
  ],
  audit: [
    { time: "10:24:18", actor: "Nadia Rahman", action: "Finalised Match 12", detail: "Marina Blue 4–3 Harbour Gold" },
    { time: "10:24:19", actor: "System", action: "Recalculated Group B", detail: "Standings snapshot st_04 published" },
    { time: "09:40:03", actor: "Marcus Lim", action: "Published schedule", detail: "Revision sch_04" },
    {
      time: "09:32:41",
      actor: "Priya Nair",
      action: "Issued scoring pass",
      detail: "Match 12 · Scorekeeper · expires 11:00",
    },
  ],
  scheduleRows: phase2ScheduleGrid.map((row, index) => ({ id: `demo-${index}`, time: row[0], cells: row.slice(1) })),
  accessPasses: [
    {
      id: "pass-m12",
      matchId: "M12",
      role: "scorekeeper",
      displayCode: "••••••••••••",
      expiresAt: "11:00",
      revoked: false,
      status: "active",
    },
    {
      id: "pass-m13",
      matchId: "M13",
      role: "viewer",
      displayCode: "••••••••••••",
      expiresAt: "10:30",
      revoked: false,
      status: "active",
    },
    {
      id: "pass-m14",
      matchId: "M14",
      role: "scorekeeper",
      displayCode: "••••••••••••",
      expiresAt: "10:30",
      revoked: false,
      status: "active",
    },
  ],
  settings: canoePoloSettings,
  capacityAreas: [
    { name: "Court 1", availability: "08:00–13:00", slotCount: 10 },
    { name: "Court 2", availability: "08:00–13:00", slotCount: 10 },
  ],
  availableCapacity: 20,
  attention: { body: phase2Copy.attentionBody, href: "/organiser/competitions/cmp_sgopen_2026/access" },
  publishedVersionLabel: phase2Copy.publishedVersion,
  publicationState: "published",
  canEdit: true,
};

export const demoCompetitionReadPort: CompetitionReadPort = {
  async getBySlug(slug) {
    return slug === phase2Competition.slug ? phase2Competition : null;
  },
};

export function isOrganiserSection(value: string): value is OrganiserSection {
  return organiserSections.some((section) => section.id === value);
}
