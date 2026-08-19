import type { Phase3SportCode } from "./phase-3.js";

export type PublicParticipant = {
  id: string | null;
  name: string;
};

export type PublicScheduledMatch = {
  id: string;
  code: string;
  stage: string;
  home: PublicParticipant;
  away: PublicParticipant;
  starts_at: string;
  ends_at: string;
  area: { id: string; name: string };
};

export type PublicMatchResult = {
  id: string;
  code: string;
  stage: string;
  home: PublicParticipant;
  away: PublicParticipant;
  home_score: number;
  away_score: number;
  state: "final" | "corrected";
  updated_at: string;
};

export type PublicDivisionProjection = {
  division: { id: string; name: string };
  schedule: PublicScheduledMatch[];
  results: PublicMatchResult[];
  standings: Record<string, unknown> | null;
  bracket: Record<string, unknown> | null;
};

export type PublicCompetitionSummary = {
  id: string;
  name: string;
  slug: string;
  sport_code: Phase3SportCode;
  timezone: string;
  starts_on: string;
  ends_on: string;
  status: "active" | "completed" | "archived";
};

export type PublicCompetitionListing = {
  competitions: PublicCompetitionSummary[];
};

export type PublicCompetitionProjection = {
  competition: {
    id: string;
    name: string;
    slug: string;
    sport_code: Phase3SportCode;
    timezone: string;
    starts_on: string;
    ends_on: string;
    status: "active" | "completed" | "archived";
  };
  divisions: PublicDivisionProjection[];
  /** @deprecated Use divisions. Retained as the first complete division package for compatibility. */
  division: { id: string; name: string };
  publication: { schedule_version: number; result_version: number };
  /** @deprecated Use divisions. Retained as the first complete division package for compatibility. */
  schedule: PublicScheduledMatch[];
  /** @deprecated Use divisions. Retained as the first complete division package for compatibility. */
  results: PublicMatchResult[];
  /** @deprecated Use divisions. Retained as the first complete division package for compatibility. */
  standings: Record<string, unknown> | null;
  /** @deprecated Use divisions. Retained as the first complete division package for compatibility. */
  bracket: Record<string, unknown> | null;
  last_updated_at: string;
};

export type ResultMutationReceipt = {
  match_id: string;
  aggregate_version: number;
  through_sequence: number;
  duplicate: boolean;
  result_version: number;
  publication_version: number;
  conflicts: Record<string, unknown>[];
};

export type ScoringFinalisationReceipt = {
  match_id: string;
  sequence: number;
  aggregate_version: number;
  duplicate: boolean;
  home_score: number;
  away_score: number;
  result_version: number;
};

export type ScoringSessionState = {
  competition: { slug: string; sport_code: Phase3SportCode };
  sport: { pack_version: string; settings: Record<string, unknown> };
  match: {
    id: string;
    code: string;
    stage: string;
    state: "pending" | "ready" | "in_progress" | "final" | "corrected";
    home: { id: string | null; name: string | null };
    away: { id: string | null; name: string | null };
  };
  access: {
    mode: "writer" | "candidate" | "viewer" | "transferred";
    permissions: Array<"score:read" | "score:write" | "score:reverse" | "score:finalise">;
    session_expires_at: string;
  };
  writer: { generation: number | null; expires_at: string | null; read_only: boolean };
  score: {
    home: number;
    away: number;
    lifecycle: "not_started" | "in_progress" | "finalised";
    current_segment: number;
    total_points: { home: number; away: number };
    segment_wins: { home: number; away: number };
    segments: Array<{
      number: number;
      home: number;
      away: number;
      completed: boolean;
      winner: "home" | "away" | null;
    }>;
    actions: Array<{
      event_id: string;
      client_event_id: string;
      event_type: string;
      label: string;
      side: "home" | "away" | null;
      participant_id: string | null;
      segment_number: number;
      score_delta: number;
      occurred_at: string;
      reversed: boolean;
      reversible: boolean;
    }>;
    conflicts: Array<{
      code: "segment_reopened_after_reversal";
      segment_number: number;
      target_event_id: string;
      later_segment_numbers: number[];
    }>;
  };
  aggregate_version: number;
  through_sequence: number;
  events: Array<{
    event_id?: string;
    client_event_id: string;
    sequence: number;
    type: string;
    team_slot: "home" | "away" | null;
    scorer: string | null;
    manual_period: number | null;
    manual_event_seconds: number | null;
    payload: Record<string, unknown>;
    correction_reason: string | null;
    occurred_at: string;
  }>;
};
