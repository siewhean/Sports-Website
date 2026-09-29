/** Authoritative competition official management contracts (SCH-006). */

export type CompetitionOfficial = {
  id: string;
  competition_id: string;
  name: string;
  default_role: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type OfficialAvailabilityWindow = {
  starts_at: string;
  ends_at: string;
};

export type MatchOfficialAssignment = {
  match_id: string;
  official_id: string;
  assigned_role: string | null;
  official?:
    | {
        id: string;
        name: string;
        default_role: string | null;
        archived: boolean;
      }
    | undefined;
};

export type CreateCompetitionOfficialRequest = {
  name: string;
  default_role?: string | null | undefined;
};

export type UpdateCompetitionOfficialRequest = {
  name?: string | undefined;
  default_role?: string | null | undefined;
};

export type ReplaceOfficialAvailabilityRequest = {
  windows: ReadonlyArray<{
    starts_at: string;
    ends_at: string;
  }>;
};

export type ReplaceMatchOfficialsRequest = {
  assignments: ReadonlyArray<{
    official_id: string;
    assigned_role?: string | null | undefined;
  }>;
};

export type ListOfficialsResponse = {
  items: readonly CompetitionOfficial[];
};

export type OfficialAvailabilityResponse = {
  windows: readonly OfficialAvailabilityWindow[];
};

export type MatchOfficialsResponse = {
  assignments: readonly MatchOfficialAssignment[];
};

export type OfficialWorkspaceResponse = {
  officials: readonly CompetitionOfficial[];
  availability: Record<string, readonly OfficialAvailabilityWindow[]>;
  assignments: readonly MatchOfficialAssignment[];
};
