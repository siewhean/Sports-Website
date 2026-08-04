function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isGateCC4RevisionResponse(value: unknown): boolean {
  return (
    record(value) &&
    record(value.revision) &&
    uuid(value.revision.repair_revision_id) &&
    Number.isSafeInteger(value.revision.revision) &&
    Array.isArray(value.actions) &&
    Array.isArray(value.unresolved_action_keys) &&
    typeof value.publication_ready === "boolean"
  );
}

export function isGateCC4PublicationReceipt(value: unknown): boolean {
  return (
    record(value) &&
    uuid(value.competition_id) &&
    uuid(value.repair_id) &&
    uuid(value.repair_revision_id) &&
    uuid(value.schedule_revision_id) &&
    Number.isSafeInteger(value.schedule_version) &&
    Number.isSafeInteger(value.result_version) &&
    Number.isSafeInteger(value.projection_version) &&
    sha256(value.analysis_fingerprint) &&
    typeof value.duplicate === "boolean" &&
    typeof value.published_at === "string" &&
    Number.isFinite(Date.parse(value.published_at))
  );
}

export function isGateCC4AbandonResponse(value: unknown): boolean {
  return record(value) && uuid(value.repair_id) && Number.isSafeInteger(value.revision) && value.status === "abandoned";
}
