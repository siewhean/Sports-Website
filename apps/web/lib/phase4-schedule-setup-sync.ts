import type {
  Phase4SetupDocument,
  Phase4SetupReviewSelection,
  Phase4SetupScheduleSelection,
} from "@matchday/contracts";
import {
  parseAssistedSetupAutosaveResponse,
  parseAssistedSetupDocument,
  setupAutosaveBody,
  stepValue,
} from "./phase4-assisted-setup-current";
import { parseScheduleRevisionView, type ScheduleOption } from "./phase4-schedule";

type Fetcher = typeof fetch;

type ScheduleRevisionWire = Readonly<{
  id: string;
  assignmentHash: string;
  sourceJobId: string;
  sourceOptionId: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scheduleWire(value: unknown, expectedStatus: "ready_for_review" | "published"): ScheduleRevisionWire | null {
  const parsed = parseScheduleRevisionView(value, true, true);
  const wire = record(value);
  if (
    !parsed ||
    parsed.status !== expectedStatus ||
    !wire ||
    typeof wire.assignment_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(wire.assignment_hash) ||
    typeof wire.source_job_id !== "string" ||
    typeof wire.source_option_id !== "string"
  )
    return null;
  return {
    id: parsed.id,
    assignmentHash: wire.assignment_hash,
    sourceJobId: wire.source_job_id,
    sourceOptionId: wire.source_option_id,
  };
}

function acceptedSchedule(value: unknown): ScheduleRevisionWire | null {
  return scheduleWire(value, "ready_for_review");
}

function publishedSchedule(value: unknown): ScheduleRevisionWire | null {
  const wire = record(value);
  if (!wire) return null;
  const { schedule_version: scheduleVersion, ...revision } = wire;
  if (!Number.isSafeInteger(scheduleVersion) || Number(scheduleVersion) < 1) return null;
  return scheduleWire(revision, "published");
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function resumeSetup(competitionId: string, fetcher: Fetcher): Promise<Phase4SetupDocument> {
  const response = await fetcher(
    `/api/phase4/competitions/${encodeURIComponent(competitionId)}/setup-draft/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
    },
  );
  const payload = await responseJson(response);
  const document = parseAssistedSetupDocument(payload, competitionId);
  if (!response.ok || !document) throw new Error("Unable to resume the canonical Assisted Setup document");
  if (document.permission !== "write" || document.read_only || document.status !== "active") {
    throw new Error("Assisted Setup is not editable");
  }
  return document;
}

async function saveStep<Step extends "schedule_review" | "review_publish">(
  competitionId: string,
  document: Phase4SetupDocument,
  stepId: Step,
  value: NonNullable<Phase4SetupDocument["values"][Step]>,
  fetcher: Fetcher,
): Promise<Phase4SetupDocument> {
  const response = await fetcher(`/api/phase4/competitions/${encodeURIComponent(competitionId)}/setup-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(setupAutosaveBody(document.revision, { kind: "save_step", step: stepValue(stepId, value) })),
  });
  const payload = await responseJson(response);
  const parsed = parseAssistedSetupAutosaveResponse(payload, competitionId);
  if (!response.ok || !parsed || parsed.outcome === "conflict" || parsed.outcome === "idempotency_mismatch") {
    throw new Error(`Unable to save Assisted Setup ${stepId} evidence`);
  }
  if (parsed.outcome === "expired" || parsed.outcome === "read_only") {
    throw new Error("Assisted Setup became read only before schedule evidence was saved");
  }
  return parsed.document;
}

function settingsPointers(document: Phase4SetupDocument) {
  const settings = document.values.settings;
  if (!settings?.length) throw new Error("Canonical settings evidence is unavailable");
  return settings.map(({ scope, division_id, settings_revision, pack_definition_hash }) => ({
    scope,
    division_id,
    settings_revision,
    pack_definition_hash,
  }));
}

function selectedRecommendation(document: Phase4SetupDocument) {
  const selection = document.values.format_recommendations;
  const selectedId = selection?.selected_recommendation_id;
  const selected = selectedId
    ? [...(selection?.recommendations ?? []), ...(selection?.requires_changes ? [selection.requires_changes] : [])].find(
        (candidate) => candidate.id === selectedId,
      )
    : null;
  if (!selected || !selected.format_revision_id) {
    throw new Error("A canonical selected format is required before saving schedule evidence");
  }
  return selected;
}

export async function syncAcceptedScheduleWithSetup(
  input: Readonly<{
    competitionId: string;
    sourceRevision: number;
    capacityRevision: number;
    option: ScheduleOption;
    response: unknown;
  }>,
  fetcher: Fetcher = fetch,
): Promise<Phase4SetupDocument> {
  const accepted = acceptedSchedule(input.response);
  if (!accepted) throw new Error("The accepted schedule response is invalid");
  if (
    accepted.sourceJobId !== input.option.jobId ||
    accepted.sourceOptionId !== input.option.id ||
    accepted.assignmentHash !== input.option.assignmentHash
  ) {
    throw new Error("The accepted schedule does not match the selected solver option");
  }
  const document = await resumeSetup(input.competitionId, fetcher);
  const selected = selectedRecommendation(document);
  const current = document.values.schedule_review;
  if (current?.schedule_revision_id === accepted.id && current.selected_result_hash === accepted.assignmentHash) {
    return document;
  }
  const schedule: Phase4SetupScheduleSelection = {
    schedule_job_id: input.option.jobId,
    source_revision: input.sourceRevision,
    selected_recommendation_id: selected.id,
    format_revision_id: selected.format_revision_id,
    format_definition_hash: selected.format_definition_hash,
    capacity_revision: input.capacityRevision,
    settings_references: settingsPointers(document),
    selected_result_revision: input.option.resultRevision,
    selected_result_hash: accepted.assignmentHash,
    objective: input.option.objective,
    schedule_revision_id: accepted.id,
    feasibility: "valid",
  };
  return saveStep(input.competitionId, document, "schedule_review", schedule, fetcher);
}

export async function syncPublishedScheduleWithSetup(
  input: Readonly<{ competitionId: string; response: unknown }>,
  fetcher: Fetcher = fetch,
): Promise<Phase4SetupDocument> {
  const published = publishedSchedule(input.response);
  if (!published) throw new Error("The published schedule response is invalid");
  const document = await resumeSetup(input.competitionId, fetcher);
  const schedule = document.values.schedule_review;
  if (
    !schedule ||
    schedule.schedule_revision_id !== published.id ||
    schedule.schedule_job_id !== published.sourceJobId ||
    schedule.selected_result_hash !== published.assignmentHash
  ) {
    throw new Error("The published revision does not match Assisted Setup schedule evidence");
  }
  const current = document.values.review_publish;
  if (current?.publication_status === "published" && current.published_schedule_revision_id === published.id) {
    return document;
  }
  const review: Phase4SetupReviewSelection = {
    selected_format_revision_id: schedule.format_revision_id,
    selected_schedule_result_hash: schedule.selected_result_hash,
    capacity_revision: schedule.capacity_revision,
    settings_references: schedule.settings_references,
    acknowledged_warning_codes: [],
    publication_status: "published",
    published_schedule_revision_id: published.id,
  };
  return saveStep(input.competitionId, document, "review_publish", review, fetcher);
}
