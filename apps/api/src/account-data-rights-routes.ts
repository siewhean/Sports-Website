import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { AccountDataRightsRuntime } from "./account-data-rights-runtime.js";

const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);

const mutationHeadersSchema = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});

function expiredSessionCookie(name: string, secure: boolean): string {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export async function registerAccountDataRightsRoutes(
  app: FastifyInstance,
  options: {
    runtime: AccountDataRightsRuntime;
    requests: IdentityRequestContext;
    allowedOrigins: readonly string[];
    verifyCsrfToken: (sessionToken: string, csrfToken: string) => boolean;
    cookie: { name: string; secure: boolean };
  },
): Promise<void> {
  const requireMutationSession = async (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin)) {
      throw new ApiError(403, ErrorCode.ORIGIN_REJECTED, "Request origin is not allowed");
    }
    const session = await options.requests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.verifyCsrfToken(session.sessionToken, csrf)) {
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    }
    return session;
  };

  app.get(
    "/api/v1/account/data-export",
    {
      schema: {
        description: "Download a JSON copy of the personal data held about the authenticated account (PDPA access).",
        security: [{ sessionCookie: [] }],
        response: { 200: Type.Unknown(), 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse },
        tags: ["account"],
      },
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (request, reply: FastifyReply) => {
      const session = await options.requests.authenticate(request);
      const payload = await options.runtime.exportAccountData(session.account.id, request.id);
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header("cache-control", "no-store")
        .header("content-disposition", `attachment; filename="matchday-account-data-${stamp}.json"`)
        .type("application/json; charset=utf-8")
        .send(JSON.stringify(payload, null, 2));
    },
  );

  app.post<{ Body: { confirmation: string } }>(
    "/api/v1/account/deletion",
    {
      schema: {
        description:
          "Delete the authenticated account by anonymisation. Requires the typed confirmation phrase, CSRF and an allowed Origin.",
        security: [{ sessionCookie: [] }],
        headers: mutationHeadersSchema,
        body: Type.Object(
          { confirmation: Type.String({ minLength: 1, maxLength: 100 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
        tags: ["account"],
      },
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (request, reply: FastifyReply) => {
      const session = await requireMutationSession(request);
      const result = await options.runtime.deleteAccount({
        accountId: session.account.id,
        confirmation: request.body.confirmation,
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      reply.header("Set-Cookie", expiredSessionCookie(options.cookie.name, options.cookie.secure));
      return result;
    },
  );
}
