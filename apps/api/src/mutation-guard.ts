import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";

/**
 * Shared guard for cookie-authenticated, state-changing routes.
 *
 * Cookie sessions are ambient credentials, so every mutation must prove it was issued by one of our
 * own origins (Origin allow-list, default deny) AND carry the per-session CSRF token. The token is
 * compared in constant time so response timing cannot be used to recover it byte by byte.
 */
export type MutationSession = { account: { id: string }; csrfToken: string };

export type MutationSessionAuthenticator<S extends MutationSession> = {
  authenticate(request: FastifyRequest): Promise<S>;
};

export function constantTimeEquals(supplied: unknown, expected: string | undefined | null): boolean {
  if (typeof supplied !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const actual = Buffer.from(supplied, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  // Length is not secret (tokens have a fixed format); equal lengths are required by timingSafeEqual.
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function requireAllowedMutationOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    throw new ApiError(403, ErrorCode.ORIGIN_REJECTED, "Request origin is not allowed");
  }
}

export function verifyMutationCsrf(request: FastifyRequest, session: MutationSession): void {
  const header = request.headers["x-csrf-token"];
  if (!constantTimeEquals(header, session.csrfToken)) {
    throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
  }
}

/** Origin allow-list, then authentication, then constant-time CSRF verification. */
export async function requireMutationSession<S extends MutationSession>(
  request: FastifyRequest,
  identityRequests: MutationSessionAuthenticator<S>,
  allowedOrigins: readonly string[],
): Promise<S> {
  requireAllowedMutationOrigin(request, allowedOrigins);
  const session = await identityRequests.authenticate(request);
  verifyMutationCsrf(request, session);
  return session;
}

export function createMutationGuard<S extends MutationSession>(
  identityRequests: MutationSessionAuthenticator<S>,
  allowedOrigins: readonly string[],
) {
  return (request: FastifyRequest) => requireMutationSession(request, identityRequests, allowedOrigins);
}
