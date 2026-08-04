/**
 * Protocol constants shared by the Gate C4 organiser BFF routes.
 *
 * These values are intentionally kept outside route handlers: they are
 * protocol values, not user-facing copy, and a single typed source prevents
 * the BFF from drifting from the API contract.
 */
export const gateCC4BffMachine = {
  headers: {
    cacheControl: "cache-control",
  },
  cache: {
    noStore: "no-store",
  },
  methods: {
    post: "POST",
  },
  fields: {
    correctionTransactionId: "correction_transaction_id",
  },
  errors: {
    authRequired: "AUTH_REQUIRED",
    referenceReadFailed: "REFERENCE_READ_FAILED",
    referenceResponseInvalid: "REFERENCE_RESPONSE_INVALID",
    repairReadFailed: "REPAIR_READ_FAILED",
    repairResponseInvalid: "REPAIR_RESPONSE_INVALID",
    repairIntakeReadFailed: "REPAIR_INTAKE_READ_FAILED",
    repairIntakeResponseInvalid: "REPAIR_INTAKE_RESPONSE_INVALID",
    requestInvalid: "REQUEST_INVALID",
  },
} as const;

export type GateCC4BffErrorCode = (typeof gateCC4BffMachine.errors)[keyof typeof gateCC4BffMachine.errors];
