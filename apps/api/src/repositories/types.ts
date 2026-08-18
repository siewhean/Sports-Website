import type { PostgresJsSql } from "@matchday/identity";

export type SqlExecutor = PostgresJsSql;

export type LockMode = "for_update" | "for_share" | "none";

export type CompetitionRecord = {
  id: string;
  organisation_id: string;
  created_by?: string;
  name: string;
  slug: string;
  status: string;
  sport_code: string;
  venue?: string;
  address?: string;
  locality?: string | null;
  country_code?: string;
  starts_on?: string;
  ends_on?: string;
  timezone?: string;
  locale?: string;
  sport_pack_version?: string;
  capacity_revision: number;
  revision?: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type OrganisationRecord = {
  id: string;
  name: string;
  slug: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type DivisionRecord = {
  id: string;
  competition_id: string;
  name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SetupDraftRecord = {
  id: string;
  schema_version: 1;
  organisation_id: string;
  competition_id: string;
  competition_status: string;
  status: "active" | "completed" | "expired";
  revision: number;
  current_step: string;
  completed_steps: readonly string[] | string;
  steps: Record<string, unknown> | string;
  validation: Record<string, unknown> | string;
  created_by?: string;
  updated_by?: string;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
};

export type FormatRevisionRecord = {
  id: string;
  competition_id: string;
  division_id: string;
  revision: number;
  definition: unknown;
  definition_hash: string;
  status: "draft" | "published" | "archived" | "superseded";
  parent_revision_id: string | null;
  root_revision_id: string | null;
  template_version_id?: string | null;
  source_kind?: string;
  layout: Record<string, unknown> | string;
  created_by?: string;
  created_at: Date | string;
  published_at: Date | string | null;
  graph_materialized_at: Date | string | null;
  graph_materialization_hash: string | null;
  graph_match_count: number | null;
};

export type ScheduleRevisionRecord = {
  id: string;
  competition_id: string;
  format_revision_id: string;
  revision: number;
  status: "draft" | "published" | "archived" | "superseded";
  input_hash: string;
  warnings: readonly unknown[];
  created_by?: string;
  created_at: Date | string;
  published_at: Date | string | null;
};

export type ScheduleJobRecord = {
  id: string;
  competition_id: string;
  format_revision_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  input_hash: string;
  created_by?: string;
  created_at: Date | string;
  completed_at?: Date | string | null;
};

export type ScheduleOptionRecord = {
  id: string;
  job_id: string;
  result_revision: number;
  quality: unknown;
  assignments: unknown;
  warnings: readonly unknown[];
  created_at: Date | string;
};

export type ScoringSessionRecord = {
  id: string;
  pass_id: string;
  competition_id: string;
  match_id: string;
  mode: string;
  status: "active" | "transferred" | "revoked" | "expired";
  created_at: Date | string;
  last_heartbeat_at: Date | string;
  expires_at: Date | string;
};

export type ScoringAccessPassRecord = {
  id: string;
  competition_id: string;
  match_id: string;
  role: "scorer" | "viewer";
  status: "active" | "revoked" | "expired";
  code_hash: string;
  token_hash: string;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string;
};

export type MatchRecord = {
  id: string;
  competition_id: string;
  division_id: string;
  match_code?: string;
  home_entry_id: string | null;
  away_entry_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type MatchWriterLeaseRecord = {
  match_id: string;
  session_id: string;
  generation: number;
  acquired_at: Date | string;
  expires_at: Date | string;
};

export type PublicationRecord = {
  competition_id: string;
  schedule_version: number;
  result_version: number;
  published_at?: Date | string | null;
};

export type AccountRecord = {
  id: string;
  email: string;
  name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type OrganisationMembershipRecord = {
  id: string;
  organisation_id: string;
  account_id: string;
  role: "owner" | "organiser" | "viewer";
  status: "active" | "suspended" | "invited";
  created_at: Date | string;
  updated_at: Date | string;
};

export type DivisionEntryRecord = {
  id: string;
  division_id: string;
  competition_id: string;
  name: string;
  seed: number | null;
  status: "active" | "withdrawn";
  created_at: Date | string;
  updated_at: Date | string;
};
