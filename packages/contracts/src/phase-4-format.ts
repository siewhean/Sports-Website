/**
 * Phase 4 format-builder wire contracts.
 *
 * The graph shape deliberately mirrors the Phase 3 domain graph. Builder-only
 * presentation data is stored separately so switching editor modes cannot
 * change the deterministic format definition.
 */

export type Phase4FormatStageKind =
  "round_robin" | "group" | "single_elimination" | "placement" | "consolation" | "classification" | "bronze";

export type Phase4FormatParticipantSource =
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

export type Phase4AdditionalQualifierRule = {
  readonly method: "best_across_groups" | "bottom_from_each_group" | "manual";
  readonly count: number;
  readonly destinationStageId: string;
};

export type Phase4PlacementRule = {
  readonly coverage: "champion_only" | "podium" | "full" | "custom";
  readonly positions: readonly number[];
};

export type Phase4FormatGraphMatch = {
  readonly id: string;
  readonly stageId: string;
  readonly poolId?: string;
  readonly round: number;
  readonly order: number;
  readonly purpose: "pool" | "progression" | "championship" | "placement" | "classification";
  readonly home: Phase4FormatParticipantSource;
  readonly away: Phase4FormatParticipantSource;
};

export type Phase4FormatGraphStage = {
  readonly id: string;
  readonly label: string;
  readonly kind: Phase4FormatStageKind;
  readonly order: number;
  readonly groupIds: readonly string[];
  readonly groupSize: number | null;
  readonly outputRanks: number;
  readonly matchIds: readonly string[];
  /** Manual-builder authoring values. Omitted on legacy Phase 3 graphs. */
  readonly repetitions?: number;
  readonly qualificationPositions?: readonly number[];
  readonly additionalQualifiers?: readonly Phase4AdditionalQualifierRule[];
  readonly destinationStageIds?: readonly string[];
  readonly seeding?: "seeded" | "snake" | "random" | "manual";
  readonly placementRule?: Phase4PlacementRule;
  readonly carriedResults?: "none" | "head_to_head" | "all";
};

export type Phase4FormatGraph = {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly entryCount: number;
  readonly stages: readonly Phase4FormatGraphStage[];
  readonly matches: readonly Phase4FormatGraphMatch[];
  readonly terminalMatchIds: readonly string[];
};

export type Phase4FormatCanvasPosition = {
  readonly stage_id: string;
  readonly x: number;
  readonly y: number;
};

export type Phase4FormatBuilderDocument = {
  readonly schema_version: 1;
  readonly graph: Phase4FormatGraph;
  readonly layout: {
    readonly schema_version: 1;
    readonly stage_positions: readonly Phase4FormatCanvasPosition[];
  };
};

export type Phase4FormatValidationIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type Phase4MaterialisedMatch = {
  readonly graph_match_id: string;
  readonly stage_id: string;
  readonly pool_id: string | null;
  readonly round: number;
  readonly sequence: number;
  readonly purpose: Phase4FormatGraphMatch["purpose"];
  readonly home: Phase4FormatParticipantSource;
  readonly away: Phase4FormatParticipantSource;
  readonly dependency_match_ids: readonly string[];
};

export type Phase4FormatMaterialisationPlan = {
  readonly schema_version: 1;
  readonly format_id: string;
  readonly graph_hash: string;
  readonly entry_count: number;
  readonly match_count: number;
  readonly matches: readonly Phase4MaterialisedMatch[];
};

/** Validation is read-only. A valid response is evidence, never a persistence command. */
export type Phase4FormatValidationRequest = {
  readonly competition_id: string;
  readonly division_id: string;
  readonly document: Phase4FormatBuilderDocument;
};

export type Phase4FormatValidationResponse =
  | {
      readonly valid: true;
      readonly issues: readonly [];
      readonly graph_hash: string;
      readonly materialisation: Phase4FormatMaterialisationPlan;
    }
  | {
      readonly valid: false;
      readonly issues: readonly Phase4FormatValidationIssue[];
      readonly graph_hash: null;
      readonly materialisation: null;
    };

export type Phase4FormatRevisionStatus = "draft" | "published" | "superseded";

export type Phase4FormatRevisionLineage = {
  readonly revision_id: string;
  readonly revision: number;
  readonly parent_revision_id: string | null;
  readonly root_revision_id: string;
};

export type Phase4FormatRevisionView = Phase4FormatRevisionLineage & {
  readonly competition_id: string;
  readonly division_id: string;
  readonly status: Phase4FormatRevisionStatus;
  readonly definition_hash: string;
  readonly document: Phase4FormatBuilderDocument;
  readonly created_at: string;
  readonly published_at: string | null;
};

export type Phase4FormatDraftPermission = "edit" | "view";

export type Phase4FormatDraftView = {
  readonly competition_id: string;
  readonly division_id: string;
  readonly draft_id: string;
  readonly parent_revision_id: string | null;
  readonly root_revision_id: string;
  readonly revision: number;
  readonly status: Phase4FormatRevisionStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly permission: Phase4FormatDraftPermission;
  readonly read_only: boolean;
  readonly definition_hash: string;
  readonly document: Phase4FormatBuilderDocument;
  readonly metrics: {
    readonly match_count: number;
    readonly guaranteed_matches: number;
    readonly maximum_matches: number;
  };
  readonly capacity: {
    readonly available_match_slots: number;
    readonly required_match_slots: number;
    readonly spare_match_slots: number;
    readonly status: "comfortable" | "tight" | "does_not_fit";
    readonly evidence_revision: number;
  };
  readonly validation: {
    readonly pending: boolean;
    readonly validated_definition_hash: string | null;
    readonly issues: readonly Phase4FormatValidationIssue[];
  };
};

export type Phase4SaveFormatRevisionRequest = {
  /** Optimistic concurrency token for the current division draft. */
  readonly draft_id: string | null;
  readonly expected_revision: number | null;
  readonly parent_revision_id: string | null;
  readonly document: Phase4FormatBuilderDocument;
};

export type Phase4OrganiserTemplateView = {
  readonly template_id: string;
  readonly template_version_id: string;
  readonly parent_version_id: string | null;
  readonly organisation_id: string;
  readonly created_by_account_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sport_code: string;
  readonly source_format_revision_id: string;
  readonly status: "active" | "archived";
  readonly definition_hash: string;
  readonly document: Phase4FormatBuilderDocument;
  readonly revision: number;
  readonly template_created_at: string;
  readonly version_created_at: string;
  readonly archived_by_account_id: string | null;
  readonly archived_at: string | null;
};

export type Phase4SaveOrganiserTemplateRequest =
  | {
      readonly template_id: null;
      readonly parent_version_id: null;
      readonly expected_version: null;
      readonly name: string;
      readonly description?: string | null;
      readonly sport_code: string;
      readonly source_format_revision_id: string;
    }
  | {
      readonly template_id: string;
      readonly parent_version_id: string;
      readonly expected_version: number;
      readonly name: string;
      readonly description?: string | null;
      readonly sport_code: string;
      readonly source_format_revision_id: string;
    };

export type Phase4ArchiveOrganiserTemplateRequest = {
  readonly template_id: string;
  readonly expected_status: "active";
};

/** Reuse always pins an immutable template version; it never follows "latest". */
export type Phase4ReuseOrganiserTemplateRequest = {
  readonly competition_id: string;
  readonly division_id: string;
  readonly template_version_id: string;
  readonly expected_format_revision: number | null;
};
