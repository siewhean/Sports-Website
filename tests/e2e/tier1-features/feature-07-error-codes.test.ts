import { describe, it, expect } from "vitest";
import { ErrorCode, type ApiErrorCode } from "@matchday/contracts";
import { ApiError } from "../../../apps/api/src/errors";
import { assertValidErrorCode } from "../helpers/test-utils";

describe("Tier 1 - Feature 07: Centralized ErrorCode Strict Contract", () => {
  it("F07-T01: ErrorCode provides central enumeration for auth, repair, scoring, and conflict domains", () => {
    expect(ErrorCode.AUTHENTICATION_REQUIRED).toBe("AUTHENTICATION_REQUIRED");
    expect(ErrorCode.SCORING_PERMISSION_DENIED).toBe("SCORING_PERMISSION_DENIED");
    expect(ErrorCode.REPAIR_REVISION_CONFLICT).toBe("REPAIR_REVISION_CONFLICT");
    expect(ErrorCode.REPAIR_PUBLICATION_FINGERPRINT_MISMATCH).toBe("REPAIR_PUBLICATION_FINGERPRINT_MISMATCH");
    expect(ErrorCode.SCORING_ACCESS_HMAC_KEY_VERSION_UNKNOWN).toBe("SCORING_ACCESS_HMAC_KEY_VERSION_UNKNOWN");
  });

  it("F07-T02: ApiError instantiates with statusCode, typed ApiErrorCode, and message", () => {
    const error = new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case was not found");
    expect(error.name).toBe("ApiError");
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("REPAIR_CASE_NOT_FOUND");
    expect(error.message).toBe("Repair case was not found");
    assertValidErrorCode(error.code);
  });

  it("F07-T03: ApiError maps 4xx client errors accurately according to HTTP semantics", () => {
    const unauthorized = new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Auth required");
    const forbidden = new ApiError(403, ErrorCode.ACCESS_DENIED, "Access denied");
    const notFound = new ApiError(404, ErrorCode.NOT_FOUND, "Not found");
    const conflict = new ApiError(409, ErrorCode.REPAIR_REVISION_CONFLICT, "Revision conflict");
    const unprocessable = new ApiError(422, ErrorCode.VALIDATION_ERROR, "Validation error");

    expect(unauthorized.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(notFound.statusCode).toBe(404);
    expect(conflict.statusCode).toBe(409);
    expect(unprocessable.statusCode).toBe(422);
  });

  it("F07-T04: all Gate C repair error codes are members of ErrorCode enum", () => {
    const gateCErrorCodes = [
      ErrorCode.REPAIR_CASE_NOT_FOUND,
      ErrorCode.REPAIR_REVISION_NOT_FOUND,
      ErrorCode.REPAIR_ACTION_NOT_FOUND,
      ErrorCode.REPAIR_DECISION_INVALID,
      ErrorCode.REPAIR_REVISION_CONFLICT,
      ErrorCode.REPAIR_REVISION_IMMUTABLE,
      ErrorCode.REPAIR_PUBLISH_FAILED,
      ErrorCode.REPAIR_PUBLICATION_STALE,
      ErrorCode.REPAIR_PUBLICATION_FINGERPRINT_MISMATCH,
      ErrorCode.REPAIR_ADJUSTMENT_UNKNOWN_MATCH,
    ];

    for (const code of gateCErrorCodes) {
      assertValidErrorCode(code);
    }
  });

  it("F07-T05: ApiError is an instance of Error and maintains stack trace integrity", () => {
    const error = new ApiError(500, ErrorCode.INTERNAL_ERROR, "System error occurred");
    expect(error instanceof Error).toBe(true);
    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe("string");
  });
});
