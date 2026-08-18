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
