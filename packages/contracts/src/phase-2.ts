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
  division: { id: string; name: string };
  publication: { schedule_version: number; result_version: number };
  schedule: PublicScheduledMatch[];
  results: PublicMatchResult[];
  standings: Record<string, unknown> | null;
  bracket: Record<string, unknown> | null;
  last_updated_at: string;
};

export type ScoringSessionState = {
  competition: { slug: string };
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
  score: { home: number; away: number };
  through_sequence: number;
  events: Array<{
    client_event_id: string;
    sequence: number;
    type:
      | "match_started"
      | "period_changed"
      | "goal_added"
      | "goal_reversed"
      | "card_added"
      | "card_reversed"
      | "timeout_added"
      | "incident_added"
      | "match_finalised"
      | "match_reopened"
      | "correction";
    team_slot: "home" | "away" | null;
    scorer: string | null;
    manual_period: number | null;
    manual_event_seconds: number | null;
    payload: Record<string, unknown>;
    correction_reason: string | null;
    occurred_at: string;
  }>;
};
