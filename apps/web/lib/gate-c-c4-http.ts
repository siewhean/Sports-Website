export const gateCC4Http = {
  methodGet: "GET",
  methodPost: "POST",
  methodPut: "PUT",
  jsonContentType: "application/json",
  cacheNoStore: "no-store",
  cacheControlHeader: "cache-control",
  contentDispositionHeader: "content-disposition",
  contentSha256Header: "x-matchday-content-sha256",
  anchorTag: "a",
  errors: {
    authRequired: "AUTH_REQUIRED",
    requestInvalid: "REQUEST_INVALID",
    referenceReadFailed: "REFERENCE_READ_FAILED",
    referenceResponseInvalid: "REFERENCE_RESPONSE_INVALID",
    repairReadFailed: "REPAIR_READ_FAILED",
    repairResponseInvalid: "REPAIR_RESPONSE_INVALID",
    repairIntakeReadFailed: "REPAIR_INTAKE_READ_FAILED",
    repairIntakeResponseInvalid: "REPAIR_INTAKE_RESPONSE_INVALID",
  },
} as const;

export const gateCC4UiMachine = {
  forceDynamic: "force-dynamic",
  resultsSection: "results",
  savedSyncState: "saved",
  analyseBusy: "analyse",
  publishBusy: "publish",
  abandonBusy: "abandon",
  scheduleExportBusy: "schedule-export",
  repairCreatedEvent: "matchday:gate-c-c4-repair-created",
  noChangeAction: "no_change",
  automaticUpdateAction: "automatic_update",
} as const;
