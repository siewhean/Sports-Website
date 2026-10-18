import { ErrorCode, type ApiErrorCode } from "@matchday/contracts";

export { ErrorCode, type ApiErrorCode };

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
