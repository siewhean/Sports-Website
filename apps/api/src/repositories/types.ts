import type { PostgresJsSql } from "@matchday/identity";

export type SqlExecutor = PostgresJsSql;

export type LockMode = "for_update" | "for_share" | "none";

export type CompetitionRecord = {
  id: string;
  organisation_id: string;
  name: string;
  slug: string;
  status: string;
  sport_code: string;
  sport_pack_version: string;
  capacity_revision: number;
  created_at: string;
  updated_at: string;
};

export type OrganisationRecord = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
};

export type DivisionRecord = {
  id: string;
  competition_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type SetupDraftRecord = {
  id: string;
  organisation_id: string;
  competition_id: string;
  competition_status: string;
  status: "active" | "completed" | "expired";
  revision: number;
  current_step: string;
  completed_steps: readonly string[];
  steps: Record<string, unknown>;
  validation: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
};

export type FormatRevisionRecord = {
  id: string;
  competition_id: string;
  division_id: string;
  revision: number;
  status: "draft" | "published" | "archived" | "superseded";
  definition_hash: string;
  definition: unknown;
  created_by: string;
  created_at: string;
  published_at: string | null;
};

export type ScheduleRevisionRecord = {
  id: string;
  competition_id: string;
  revision: number;
  status: "draft" | "published" | "archived" | "superseded";
  input_hash: string;
  warnings: readonly unknown[];
  created_by: string;
  created_at: string;
  published_at: string | null;
};
