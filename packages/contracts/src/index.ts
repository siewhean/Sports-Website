export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
};

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type HealthResponse = {
  service: string;
  status: HealthStatus;
  timestamp: string;
  request_id: string;
};

export type DependencyStatus = {
  database: boolean;
  redis: boolean;
  queue: boolean;
};

export type ReadinessResponse = HealthResponse & {
  dependencies: DependencyStatus;
};

export type {
  PublicCompetitionProjection,
  PublicDivisionProjection,
  PublicMatchResult,
  PublicParticipant,
  PublicScheduledMatch,
  ScoringSessionState,
} from "./phase-2.js";
export type {
  Phase3CapacityView,
  Phase3CompetitionStatus,
  Phase3CompetitionView,
  Phase3EntryView,
  Phase3FormatRevisionView,
  Phase3ImportResult,
  Phase3SettingsView,
  Phase3SportCode,
  Phase3StandingsSnapshotView,
} from "./phase-3.js";
export type {
  Phase4FormatBuilderDocument,
  Phase4FormatCanvasPosition,
  Phase4FormatDraftPermission,
  Phase4FormatDraftView,
  Phase4FormatGraph,
  Phase4FormatGraphMatch,
  Phase4FormatGraphStage,
  Phase4FormatMaterialisationPlan,
  Phase4FormatParticipantSource,
  Phase4FormatRevisionLineage,
  Phase4FormatRevisionStatus,
  Phase4FormatRevisionView,
  Phase4FormatStageKind,
  Phase4AdditionalQualifierRule,
  Phase4PlacementRule,
  Phase4FormatValidationIssue,
  Phase4FormatValidationRequest,
  Phase4FormatValidationResponse,
  Phase4MaterialisedMatch,
  Phase4ArchiveOrganiserTemplateRequest,
  Phase4OrganiserTemplateView,
  Phase4ReuseOrganiserTemplateRequest,
  Phase4SaveFormatRevisionRequest,
  Phase4SaveOrganiserTemplateRequest,
} from "./phase-4-format.js";
export {
  phase4AiActionKinds,
  phase4AiMissingFields,
  type Phase4AiAccountingDecision,
  type Phase4AiActionKind,
  type Phase4AiAuditMetadata,
  type Phase4AiBriefWorkflowState,
  type Phase4AiFailureCode,
  type Phase4AiMappingResult,
  type Phase4AiMissingField,
  type Phase4CompetitionBrief,
  type Phase4FormatRecommendationInput,
  type Phase4SetupInput,
} from "./phase-4-ai.js";
export type {
  ScheduleAssignment,
  ScheduleCandidate,
  ScheduleCandidateRequest,
  ScheduleConstraintSetting,
  ScheduleConstraintMode,
  ScheduleConstraints,
  ScheduleInterval,
  ScheduleJobInput,
  ScheduleJobResult,
  ScheduleJobStatus,
  ScheduleJobView,
  ScheduleObjective,
  ScheduleOptionView,
  ScheduleQuality,
  ScheduleQualityComponent,
  ScheduleRevisionStatus,
  ScheduleRevisionView,
  ScheduleValidation,
  ScheduleViolation,
  ScheduleViolationCode,
  ScheduleWorkerMatch,
  ScheduleWorkerSlot,
  IntrinsicScheduleHardConstraint,
} from "./phase-4-schedule.js";
export { intrinsicScheduleHardConstraints } from "./phase-4-schedule.js";
export {
  mapSetupValuesToFormatRecommendationInput,
  phase4SetupStepIds,
  type Phase4SetupAutosaveRequest,
  type Phase4SetupAutosaveResponse,
  type Phase4SetupAutosaveState,
  type Phase4SetupBasics,
  type Phase4SetupCapacityReference,
  type Phase4SetupDivisionEntryReference,
  type Phase4SetupDocument,
  type Phase4SetupEntriesReference,
  type Phase4SetupFormatPreferences,
  type Phase4SetupImportReference,
  type Phase4SetupIssue,
  type Phase4SetupRecommendation,
  type Phase4SetupRecommendationInputResult,
  type Phase4SetupRecommendationSelection,
  type Phase4SetupReviewSelection,
  type Phase4SetupScheduleSelection,
  type Phase4SetupSettingsReference,
  type Phase4SetupStepId,
  type Phase4SetupStepState,
  type Phase4SetupStepValue,
  type Phase4SetupValues,
} from "./phase-4-setup.js";
export type {
  Phase4PatchableSetupStep,
  Phase4PatchableSetupStepId,
  Phase4SetupPatchRequest,
  Phase4SetupPatchResponse,
} from "./phase-4-setup-patch.js";
export {
  gateCOfflineQueueLimit,
  gateCOfflineQueueWarningCount,
  gateCOfflineRecordingDurationMs,
  gateCOfflineReplayGraceMs,
  gateCOfflineSchemaVersion,
  type GateCOfflineAcknowledgement,
  type GateCOfflineAuthorizationStatus,
  type GateCOfflineCanonicalCommand,
  type GateCOfflineCanonicalEventCommand,
  type GateCOfflineConflictCode,
  type GateCOfflineFinalisationCommand,
  type GateCOfflineMatchPackage,
  type GateCOfflineParticipant,
  type GateCOfflineQueuedCommand,
  type GateCOfflineQueueSummary,
  type GateCOfflineReplayError,
  type GateCOfflineReplayReceipt,
} from "./gate-c-offline.js";
