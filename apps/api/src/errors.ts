import { ErrorCode, type ApiErrorCode } from "@matchday/contracts";

export { ErrorCode, type ApiErrorCode };

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
