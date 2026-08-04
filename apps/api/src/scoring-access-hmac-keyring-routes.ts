import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PostgresJsSql } from "@matchday/identity";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import { ApiError } from "./errors.js";
import { retireScoringAccessHmacKeyVersion } from "./scoring-access-hmac-keyring.js";

const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});
const MutationHeaders = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});

function hasOnlyRetirementReason(value: unknown): value is { reason: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "reason")
  );
}

export async function registerScoringAccessHmacKeyringRoutes(
  app: FastifyInstance,
  options: {
    sql: PostgresJsSql;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
): Promise<void> {
  const platformAdminActor = async (request: FastifyRequest): Promise<string> => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin)) {
      throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed");
    }
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf)) {
      throw new ApiError(403, "CSRF_INVALID", "CSRF validation failed");
    }
    return session.account.id;
  };

  app.post<{
    Params: { keyVersion: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { reason: string };
  }>(
    "/api/v1/admin/scoring-access-hmac-key-versions/:keyVersion/retire",
    {
      preValidation: async (request) => {
        // Some Fastify/Ajv configurations remove unknown properties before the
        // handler. This explicit guard preserves the C5 contract: mutation
        // bodies with undeclared fields are rejected rather than normalised.
        if (!hasOnlyRetirementReason(request.body)) {
          throw new ApiError(422, "REQUEST_BODY_UNKNOWN_FIELD", "Request body contains an unknown field");
        }
      },
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object(
          { keyVersion: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }) },
          { additionalProperties: false },
        ),
        body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 1_000 }) }, { additionalProperties: false }),
        response: { 204: Type.Null(), 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["gate-c-c5-scoring-access-hmac-key-lifecycle"],
      },
    },
    async (request, reply) => {
      await retireScoringAccessHmacKeyVersion(options.sql, {
        keyVersion: request.params.keyVersion,
        accountId: await platformAdminActor(request),
        requestId: request.id,
        reason: request.body.reason,
      });
      return reply.code(204).send();
    },
  );
}
