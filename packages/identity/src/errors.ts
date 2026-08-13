export type IdentityErrorCode =
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_LINKING_REQUIRED"
  | "AUTHENTICATION_ASSURANCE_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_PROFILE"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED";

export class IdentityError extends Error {
  constructor(
    public readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(public readonly reason: string) {
    super("You do not have permission to perform this action.");
    this.name = "AuthorizationError";
  }
}

export class UnsafeAuditPayloadError extends Error {
  readonly code = "UNSAFE_AUDIT_PAYLOAD" as const;

  constructor(public readonly path: string) {
    super(`Audit payload contains a prohibited field at ${path}.`);
    this.name = "UnsafeAuditPayloadError";
  }
}
