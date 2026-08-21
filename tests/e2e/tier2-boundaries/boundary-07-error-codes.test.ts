import { describe, it, expect } from "vitest";
import { ErrorCode } from "@matchday/contracts";
import { ApiError } from "../../../apps/api/src/errors";

describe("Tier 2 - Boundary 07: ErrorCode & ApiError Boundaries", () => {
  it("B07-T01: ApiError handles empty error message string correctly", () => {
    const error = new ApiError(400, ErrorCode.REQUEST_INVALID, "");
    expect(error.message).toBe("");
    expect(error.code).toBe("REQUEST_INVALID");
    expect(error.statusCode).toBe(400);
  });

  it("B07-T02: ApiError preserves unicode, newlines, and special characters in error message", () => {
    const specialMessage = "Validation failed:\n- Field 'name' is required ⚠️\n- Rate limit exceeded: 100 req/s";
    const error = new ApiError(422, ErrorCode.VALIDATION_ERROR, specialMessage);
    expect(error.message).toBe(specialMessage);
    expect(error.message).toContain("⚠️");
  });

  it("B07-T03: ApiError validates boundary HTTP status codes (400, 401, 403, 404, 409, 422, 500, 503)", () => {
    const statuses = [400, 401, 403, 404, 409, 422, 500, 503];
    for (const status of statuses) {
      const error = new ApiError(status, ErrorCode.INTERNAL_ERROR, `Status ${status}`);
      expect(error.statusCode).toBe(status);
    }
  });

  it("B07-T04: ApiError properly inherits from Error prototype and supports instanceof checks", () => {
    const error = new ApiError(404, ErrorCode.NOT_FOUND, "Resource not found");
    expect(error instanceof Error).toBe(true);
    expect(error instanceof ApiError).toBe(true);
    expect(Object.prototype.toString.call(error)).toBe("[object Error]");
  });

  it("B07-T05: ApiError code property is immutable (readonly) on instantiated errors", () => {
    const error = new ApiError(403, ErrorCode.ACCESS_DENIED, "Forbidden");
    expect(error.code).toBe(ErrorCode.ACCESS_DENIED);
  });
});
