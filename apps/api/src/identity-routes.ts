import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { ApiError, ErrorCode } from "./errors.js";
import { IdentityFlowSealer, identityFlowTtlMs } from "./identity-flow.js";
import { IdentityProviderEventVerifier, type IdentityProviderRevocationEvent } from "./identity-provider-events.js";
import {
  IdentityApiRuntime,
  type AuthenticatedIdentityApiSession,
  type IdentityApiSession,
} from "./identity-runtime.js";

const apiErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    request_id: Type.String(),
  }),
});

const accountSchema = Type.Object({
  id: Type.String(),
  primary_email: Type.String({ format: "email" }),
  display_name: Type.String(),
  email_verified_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

const authenticatedSessionSchema = Type.Object({
  account: accountSchema,
  csrf_token: Type.String(),
  idle_expires_at: Type.String({ format: "date-time" }),
  absolute_expires_at: Type.String({ format: "date-time" }),
});

const mutationHeadersSchema = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});

type CookiePolicy = {
  name: string;
  secure: boolean;
};

type OidcFlowPolicy = {
  callbackUri: string;
  flowCookieName: string;
  hostedRecoveryUrl: string;
  postAuthRedirectUris: readonly string[];
  sealer: IdentityFlowSealer;
};

type ProviderEventPolicy = {
  verifier: IdentityProviderEventVerifier;
};

function accountPayload(account: IdentityApiSession["account"]) {
  return {
    id: account.id,
    primary_email: account.primaryEmail,
    display_name: account.displayName,
    email_verified_at: account.emailVerifiedAt?.toISOString() ?? null,
  };
}

function sessionPayload(session: IdentityApiSession) {
  return {
    account: accountPayload(session.account),
    csrf_token: session.csrfToken,
    idle_expires_at: session.idleExpiresAt.toISOString(),
    absolute_expires_at: session.absoluteExpiresAt.toISOString(),
  };
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const matches: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      matches.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function sessionCookie(policy: CookiePolicy, token: string, absoluteExpiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1_000));
  return [
    `${policy.name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(policy.secure ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
    `Expires=${absoluteExpiresAt.toUTCString()}`,
  ].join("; ");
}

function expiredSessionCookie(policy: CookiePolicy): string {
  return [
    `${policy.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(policy.secure ? ["Secure"] : []),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

function flowCookie(policy: CookiePolicy, name: string, callbackPath: string, value: string): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${callbackPath}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(policy.secure ? ["Secure"] : []),
    `Max-Age=${Math.floor(identityFlowTtlMs / 1_000)}`,
  ].join("; ");
}

function expiredFlowCookie(policy: CookiePolicy, name: string, callbackPath: string): string {
  return [
    `${name}=`,
    `Path=${callbackPath}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(policy.secure ? ["Secure"] : []),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

function requireAllowedOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    throw new ApiError(403, ErrorCode.ORIGIN_REJECTED, "Request origin is not allowed");
  }
}

function requireAllowedRedirectUri(value: string, allowedOrigins: readonly string[]): void {
  const redirect = new URL(value);
  if (
    !allowedOrigins.includes(redirect.origin) ||
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    !(
      redirect.protocol === "https:" ||
      (redirect.protocol === "http:" && (redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost"))
    )
  ) {
    throw new ApiError(400, ErrorCode.REDIRECT_URI_REJECTED, "Redirect URI is not allowed");
  }
}

function exactAllowedRedirect(value: string, allowed: readonly string[]): string {
  let canonical: string;
  try {
    canonical = new URL(value).href;
  } catch {
    throw new ApiError(400, ErrorCode.REDIRECT_URI_REJECTED, "Redirect URI is not allowed");
  }
  if (!allowed.includes(canonical)) {
    throw new ApiError(400, ErrorCode.REDIRECT_URI_REJECTED, "Redirect URI is not allowed");
  }
  return canonical;
}

export class IdentityRequestContext {
  private readonly authenticated = new WeakMap<FastifyRequest, Promise<AuthenticatedIdentityApiSession>>();

  constructor(
    private readonly runtime: IdentityApiRuntime,
    private readonly cookieName: string,
  ) {}

  authenticate(request: FastifyRequest): Promise<AuthenticatedIdentityApiSession> {
    const cached = this.authenticated.get(request);
    if (cached) return cached;
    const token = parseCookie(request.headers.cookie, this.cookieName);
    const result = token
      ? this.runtime.authenticate(token, request.id)
      : Promise.reject(new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Authentication required"));
    this.authenticated.set(request, result);
    return result;
  }

  async rateLimitAccountId(request: FastifyRequest): Promise<string | null> {
    if (!parseCookie(request.headers.cookie, this.cookieName)) return null;
    try {
      return (await this.authenticate(request)).account.id;
    } catch {
      return null;
    }
  }
}

export function createIdentityRequestContext(runtime: IdentityApiRuntime, cookieName: string) {
  return new IdentityRequestContext(runtime, cookieName);
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: {
    runtime: IdentityApiRuntime;
    requests: IdentityRequestContext;
    allowedOrigins: readonly string[];
    cookie: CookiePolicy;
    legacyDirectExchange: boolean;
    oidc?: OidcFlowPolicy;
    providerEvents?: ProviderEventPolicy;
  },
): Promise<void> {
  const requireMutationSession = async (request: FastifyRequest) => {
    requireAllowedOrigin(request, options.allowedOrigins);
    const session = await options.requests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.runtime.verifyCsrfToken(session.sessionToken, csrf)) {
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    }
    return session;
  };

  if (options.oidc) {
    const callbackPath = new URL(options.oidc.callbackUri).pathname;
    app.get<{ Querystring: { return_to?: string } }>(
      "/api/v1/identity/authorize",
      {
        schema: {
          description: "Start a server-owned OIDC authorization-code flow with PKCE, state, and nonce.",
          querystring: Type.Object({ return_to: Type.Optional(Type.String({ format: "uri", maxLength: 2_048 })) }),
          response: { 302: Type.Null(), 400: apiErrorSchema, 503: apiErrorSchema },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const fallback = options.oidc?.postAuthRedirectUris[0];
        if (!options.oidc || !fallback)
          throw new ApiError(503, ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "Identity provider is unavailable");
        const returnUri = exactAllowedRedirect(request.query.return_to ?? fallback, options.oidc.postAuthRedirectUris);
        const state = randomState();
        const nonce = randomNonce();
        const pkceVerifier = randomPKCECodeVerifier();
        const pkceChallenge = await calculatePKCECodeChallenge(pkceVerifier);
        const authorizationUrl = await options.runtime.createAuthorizationUrl({
          redirectUri: options.oidc.callbackUri,
          state,
          nonce,
          pkceChallenge,
        });
        const sealed = options.oidc.sealer.seal({ state, nonce, pkceVerifier, returnUri });
        reply.header("Set-Cookie", flowCookie(options.cookie, options.oidc.flowCookieName, callbackPath, sealed));
        return reply.redirect(authorizationUrl, 302);
      },
    );

    app.get<{
      Querystring: { code?: string; state?: string; error?: string; error_description?: string };
    }>(
      "/api/v1/identity/callback",
      {
        schema: {
          description: "Validate the OIDC response and issue an opaque application session.",
          querystring: Type.Object({
            code: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
            state: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
            error: Type.Optional(Type.String({ maxLength: 256 })),
            error_description: Type.Optional(Type.String({ maxLength: 1_024 })),
          }),
          response: {
            303: Type.Null(),
            400: apiErrorSchema,
            401: apiErrorSchema,
            403: apiErrorSchema,
            503: apiErrorSchema,
          },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        if (!options.oidc)
          throw new ApiError(503, ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "Identity provider is unavailable");
        reply.header("Set-Cookie", expiredFlowCookie(options.cookie, options.oidc.flowCookieName, callbackPath));
        const sealed = parseCookie(request.headers.cookie, options.oidc.flowCookieName);
        if (!sealed) throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Authentication required");
        const flow = options.oidc.sealer.open(sealed);
        exactAllowedRedirect(flow.returnUri, options.oidc.postAuthRedirectUris);
        if (
          request.query.error ||
          !request.query.code ||
          !request.query.state ||
          !options.oidc.sealer.stateMatches(flow.state, request.query.state)
        ) {
          throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Authentication required");
        }
        const previousSessionToken = parseCookie(request.headers.cookie, options.cookie.name);
        const session = await options.runtime.signIn(
          {
            authorizationCode: request.query.code,
            redirectUri: options.oidc.callbackUri,
            pkceVerifier: flow.pkceVerifier,
            authorizationResponseState: request.query.state,
            expectedState: flow.state,
            expectedNonce: flow.nonce,
          },
          request.id,
          previousSessionToken ?? undefined,
        );
        reply.header("Set-Cookie", [
          sessionCookie(options.cookie, session.sessionToken, session.absoluteExpiresAt),
          expiredFlowCookie(options.cookie, options.oidc.flowCookieName, callbackPath),
        ]);
        return reply.redirect(flow.returnUri, 303);
      },
    );

    app.get(
      "/api/v1/identity/recovery",
      {
        schema: {
          description: "Redirect to the configured provider-hosted recovery experience.",
          response: { 303: Type.Null() },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      },
      async (_request, reply) => reply.redirect(options.oidc?.hostedRecoveryUrl ?? "/", 303),
    );
  }

  if (options.providerEvents) {
    app.post<{
      Body: {
        event_id: string;
        type: "password_changed" | "session_revoked";
        issuer: string;
        subject?: string;
        provider_session_id?: string;
        occurred_at: string;
      };
      Headers: { "x-matchday-provider-signature"?: string };
    }>(
      "/api/v1/identity/provider-events",
      {
        schema: {
          description:
            "Accept a provider-neutral, HMAC-signed password-change or session-revocation back-channel event.",
          security: [{ providerEventSignature: [] }],
          headers: Type.Object({ "x-matchday-provider-signature": Type.Optional(Type.String({ maxLength: 128 })) }),
          body: Type.Object(
            {
              event_id: Type.String({ format: "uuid" }),
              type: Type.Union([Type.Literal("password_changed"), Type.Literal("session_revoked")]),
              issuer: Type.String({ format: "uri", maxLength: 2_048 }),
              subject: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
              provider_session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
              occurred_at: Type.String({ format: "date-time" }),
            },
            { additionalProperties: false },
          ),
          response: {
            202: Type.Object({ accepted: Type.Literal(true) }),
            400: apiErrorSchema,
            401: apiErrorSchema,
            429: apiErrorSchema,
          },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const policy = options.providerEvents;
        const supplied = request.headers["x-matchday-provider-signature"];
        if (!policy || typeof supplied !== "string") {
          throw new ApiError(401, ErrorCode.PROVIDER_EVENT_REJECTED, "Provider event authentication failed");
        }
        const event: IdentityProviderRevocationEvent = {
          eventId: request.body.event_id,
          type: request.body.type,
          issuer: request.body.issuer,
          subject: request.body.subject ?? null,
          providerSessionId: request.body.provider_session_id ?? null,
          occurredAt: request.body.occurred_at,
        };
        let occurredAt: Date;
        try {
          occurredAt = policy.verifier.verify(event, supplied);
        } catch {
          throw new ApiError(401, ErrorCode.PROVIDER_EVENT_REJECTED, "Provider event authentication failed");
        }
        await options.runtime.revokeProviderSessions(
          {
            eventId: event.eventId,
            issuer: event.issuer,
            subject: event.subject,
            providerSessionId: event.providerSessionId,
            occurredAt,
            reason: event.type === "password_changed" ? "provider_password_changed" : "provider_session_revoked",
          },
          request.id,
        );
        return reply.code(202).send({ accepted: true });
      },
    );
  }

  if (options.legacyDirectExchange)
    app.post<{
      Body: { authorization_code: string; redirect_uri: string; pkce_verifier: string };
    }>(
      "/api/v1/identity/sign-in",
      {
        schema: {
          description: "Exchange a provider authorization code and issue an opaque application session.",
          body: Type.Object({
            authorization_code: Type.String({ minLength: 8, maxLength: 4_096 }),
            redirect_uri: Type.String({ format: "uri", maxLength: 2_048 }),
            pkce_verifier: Type.String({ minLength: 43, maxLength: 128 }),
          }),
          headers: Type.Object({ origin: Type.Optional(Type.String()) }),
          response: {
            200: authenticatedSessionSchema,
            400: apiErrorSchema,
            401: apiErrorSchema,
            403: apiErrorSchema,
            503: apiErrorSchema,
          },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        requireAllowedOrigin(request, options.allowedOrigins);
        requireAllowedRedirectUri(request.body.redirect_uri, options.allowedOrigins);
        const previousSessionToken = parseCookie(request.headers.cookie, options.cookie.name);
        const session = await options.runtime.signIn(
          {
            authorizationCode: request.body.authorization_code,
            redirectUri: request.body.redirect_uri,
            pkceVerifier: request.body.pkce_verifier,
          },
          request.id,
          previousSessionToken ?? undefined,
        );
        reply.header("Set-Cookie", sessionCookie(options.cookie, session.sessionToken, session.absoluteExpiresAt));
        return sessionPayload(session);
      },
    );

  if (options.legacyDirectExchange)
    app.post<{ Body: { email: string; redirect_uri: string } }>(
      "/api/v1/identity/recovery",
      {
        schema: {
          description: "Request provider-neutral account recovery with an enumeration-resistant response.",
          body: Type.Object({
            email: Type.String({ format: "email", maxLength: 254 }),
            redirect_uri: Type.String({ format: "uri", maxLength: 2_048 }),
          }),
          headers: Type.Object({ origin: Type.Optional(Type.String()) }),
          response: {
            202: Type.Object({ accepted: Type.Literal(true) }),
            400: apiErrorSchema,
            403: apiErrorSchema,
            429: apiErrorSchema,
          },
          tags: ["identity"],
        },
        config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        requireAllowedOrigin(request, options.allowedOrigins);
        requireAllowedRedirectUri(request.body.redirect_uri, options.allowedOrigins);
        const result = await options.runtime.requestRecovery(request.body.email, request.body.redirect_uri, request.id);
        return reply.code(202).send(result);
      },
    );

  app.get(
    "/api/v1/identity/me",
    {
      schema: {
        description: "Read the authenticated account profile and per-session CSRF token.",
        security: [{ sessionCookie: [] }],
        response: { 200: authenticatedSessionSchema, 401: apiErrorSchema, 403: apiErrorSchema },
        tags: ["identity"],
      },
    },
    async (request) => sessionPayload(await options.requests.authenticate(request)),
  );

  app.patch<{ Body: { display_name: string } }>(
    "/api/v1/identity/me",
    {
      schema: {
        description: "Update the authenticated account profile and append audit evidence atomically.",
        security: [{ sessionCookie: [] }],
        headers: mutationHeadersSchema,
        body: Type.Object({ display_name: Type.String({ minLength: 1, maxLength: 100 }) }),
        response: { 200: Type.Object({ account: accountSchema }), 401: apiErrorSchema, 403: apiErrorSchema },
        tags: ["identity"],
      },
    },
    async (request) => {
      const session = await requireMutationSession(request);
      const account = await options.runtime.updateProfile(session, request.body.display_name, request.id);
      return { account: accountPayload(account) };
    },
  );

  app.post(
    "/api/v1/identity/sign-out",
    {
      schema: {
        description: "Revoke the current application session and expire its cookie.",
        security: [{ sessionCookie: [] }],
        headers: mutationHeadersSchema,
        response: { 204: Type.Null(), 401: apiErrorSchema, 403: apiErrorSchema },
        tags: ["identity"],
      },
    },
    async (request, reply: FastifyReply) => {
      const session = await requireMutationSession(request);
      await options.runtime.signOut(session, request.id);
      reply.header("Set-Cookie", expiredSessionCookie(options.cookie));
      return reply.code(204).send();
    },
  );
}
