import { Type } from "@sinclair/typebox";
import type { ScoringFallbackHmacKeyring } from "@matchday/config";
import type { PostgresJsSql } from "@matchday/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import { ApiError } from "./errors.js";
import {
  promoteScoringFallbackHmacKeyVersion,
  retireScoringFallbackHmacKeyVersion,
} from "./scoring-fallback-hmac-keyring.js";

const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});
const MutationHeaders = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});
const Params = Type.Object(
  { keyVersion: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }) },
  { additionalProperties: false },
);
const Body = Type.Object({ reason: Type.String({ minLength: 3, maxLength: 1_000 }) }, { additionalProperties: false });
function hasOnlyReason(value: unknown): value is { reason: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "reason")
  );
}

export async function registerScoringFallbackHmacKeyringRoutes(
  app: FastifyInstance,
  options: {
    sql: PostgresJsSql;
    configuredKeyring: ScoringFallbackHmacKeyring;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
): Promise<void> {
  const platformAdmin = async (request: FastifyRequest): Promise<string> => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin))
      throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed");
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf))
      throw new ApiError(403, "CSRF_INVALID", "CSRF validation failed");
    return session.account.id;
  };
  for (const [path, handler] of [
    [
      "/api/v1/admin/scoring-fallback-hmac-key-versions/:keyVersion/promote",
      async (keyVersion: string, accountId: string, requestId: string, reason: string) =>
        promoteScoringFallbackHmacKeyVersion(options.sql, {
          keyVersion,
          accountId,
          requestId,
          reason,
          configuredKeyring: options.configuredKeyring,
        }),
    ],
    [
      "/api/v1/admin/scoring-fallback-hmac-key-versions/:keyVersion/retire",
      async (keyVersion: string, accountId: string, requestId: string, reason: string) =>
        retireScoringFallbackHmacKeyVersion(options.sql, { keyVersion, accountId, requestId, reason }),
    ],
  ] as const) {
    app.post<{
      Params: { keyVersion: string };
      Headers: { origin?: string; "x-csrf-token"?: string };
      Body: { reason: string };
    }>(
      path,
      {
        preValidation: async (request) => {
          if (!hasOnlyReason(request.body))
            throw new ApiError(422, "REQUEST_BODY_UNKNOWN_FIELD", "Request body contains an unknown field");
        },
        schema: {
          security: [{ sessionCookie: [] }],
          headers: MutationHeaders,
          params: Params,
          body: Body,
          response: {
            204: Type.Null(),
            401: ErrorResponse,
            403: ErrorResponse,
            409: ErrorResponse,
            422: ErrorResponse,
          },
          tags: ["gate-c-c5-fallback-code-hmac-key-lifecycle"],
        },
      },
      async (request, reply) => {
        await handler(request.params.keyVersion, await platformAdmin(request), request.id, request.body.reason);
        return reply.code(204).send();
      },
    );
  }
}
