import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { ApiErrorEnvelope, DependencyStatus, HealthStatus } from "@matchday/contracts";
import type { AppConfig, ScoringFallbackHmacKeyring } from "@matchday/config";
import { IdentityError, systemClock, type Clock } from "@matchday/identity";
import { createLogger } from "@matchday/observability";
import { ApiError, ErrorCode } from "./errors.js";
import { IdentityAssuranceRequestContext } from "./identity-assurance-request-context.js";
import { IdentityAssuranceRuntime } from "./identity-assurance-runtime.js";
import { IdentityFlowSealer } from "./identity-flow.js";
import { IdentityProviderEventVerifier } from "./identity-provider-events.js";
import {
  createIdentityRequestContext,
  registerIdentityRoutes,
  type IdentityRequestContext,
} from "./identity-routes.js";
import { IdentityApiRuntime, IdentityProviderUnavailableError } from "./identity-runtime.js";
import type { DependencyProbes } from "./probes.js";
import { registerPhase2Routes } from "./phase-2-routes.js";
import type { Phase2Runtime } from "./phase-2-runtime.js";
import { registerPhase3Routes } from "./phase-3-routes.js";
import type { Phase3Runtime } from "./phase-3-runtime.js";
import { registerOrganiserCompetitionLibraryRoutes } from "./organiser-competition-library-routes.js";
import { GateBPhase4Runtime } from "./phase-4-gate-b-runtime.js";
import { registerPhase4Routes } from "./phase-4-routes.js";
import type { Phase4Runtime } from "./phase-4-runtime.js";
import { registerPhase4SetupPatchRoutes } from "./phase-4-setup-patch-routes.js";
import { registerGateCC4Routes } from "./gate-c-c4-routes.js";
import type { GateCC4Runtime } from "./gate-c-c4-runtime.js";
import type { GateCC4Operations } from "./gate-c-c4-operations.js";
import type { GateCC4LifecycleOperations } from "./gate-c-c4-lifecycle.js";
import { registerGateCC4PublicTruthRoutes, type GateCC4PublicTruthRuntime } from "./gate-c-c4-public-truth.js";
import { registerScoringAccessHmacKeyringRoutes } from "./scoring-access-hmac-keyring-routes.js";
import { registerScoringFallbackHmacKeyringRoutes } from "./scoring-fallback-hmac-keyring-routes.js";
import { registerBillingRoutes } from "./billing-routes.js";
import type { EntitlementRuntime } from "./entitlement-runtime.js";
import { registerExportRoutes } from "./export-routes.js";
import type { ExportRuntime } from "./export-runtime.js";
import { registerAdminRoutes } from "./admin-routes.js";
import type { AdminRuntime } from "./admin-runtime.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import type { NotificationService } from "@matchday/notifications";
import { createDisabledApiTelemetry, type ApiTelemetry, type RequestTelemetryHandle } from "./telemetry.js";
import type { PostgresJsSql } from "@matchday/identity";

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const errorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    request_id: Type.String(),
  }),
});

const healthSchema = Type.Object({
  service: Type.String(),
  status: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("unhealthy")]),
  timestamp: Type.String({ format: "date-time" }),
  request_id: Type.String(),
});

const readinessSchema = Type.Intersect([
  healthSchema,
  Type.Object({
    dependencies: Type.Object({
      database: Type.Boolean(),
      redis: Type.Boolean(),
      queue: Type.Boolean(),
    }),
  }),
]);

function requestId(request: FastifyRequest): string {
  return request.id;
}

function healthPayload(request: FastifyRequest, status: HealthStatus) {
  return {
    service: "matchday-api",
    status,
    timestamp: new Date().toISOString(),
    request_id: requestId(request),
  };
}

async function dependencyStatus(probes: DependencyProbes): Promise<DependencyStatus> {
  const [database, redis, queue] = await Promise.all([probes.database(), probes.redis(), probes.queue()]);
  return { database, redis, queue };
}

function identityErrorMapping(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (error instanceof IdentityProviderUnavailableError) {
    return { statusCode: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "Identity provider is unavailable" };
  }
  if (!(error instanceof IdentityError)) return null;
  if (error.code === "INVALID_PROFILE") {
    return { statusCode: 400, code: "INVALID_PROFILE", message: "Profile is invalid" };
  }
  if (error.code === "EMAIL_NOT_VERIFIED" || error.code === "ACCOUNT_LINKING_REQUIRED") {
    return { statusCode: 403, code: "SIGN_IN_NOT_ALLOWED", message: "Sign-in is not allowed" };
  }
  return { statusCode: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication required" };
}

export type BuildAppOptions = {
  config: AppConfig;
  probes: DependencyProbes;
  rateLimitRedis?: Redis;
  rateLimitNameSpace?: string;
  rateLimitMax?: number;
  anonymousRateLimitMax?: number;
  authenticatedRateLimitMax?: number;
  scoringSessionRateLimitMax?: number;
  resolveRateLimitAccountId?: (request: FastifyRequest) => Promise<string | null> | string | null;
  resolveVerifiedScoringRateLimitSessionId?: (request: FastifyRequest) => Promise<string | null> | string | null;
  telemetry?: ApiTelemetry;
  loggerDestination?: Parameters<typeof createLogger>[1];
  identityRuntime?: IdentityApiRuntime;
  closeIdentityResources?: () => Promise<void>;
  identityProviderEventClock?: Clock;
  phase2Runtime?: Phase2Runtime;
  phase3Runtime?: Phase3Runtime;
  phase4Runtime?: Phase4Runtime;
  gateCC4Runtime?: GateCC4Runtime;
  gateCC4Operations?: GateCC4Operations;
  gateCC4Lifecycle?: GateCC4LifecycleOperations;
  gateCC4PublicTruthRuntime?: GateCC4PublicTruthRuntime;
  scoringAccessHmacKeySql?: PostgresJsSql;
  scoringFallbackHmacKeySql?: PostgresJsSql;
  scoringFallbackHmacKeyring?: ScoringFallbackHmacKeyring;
  entitlementRuntime?: EntitlementRuntime;
  exportRuntime?: ExportRuntime;
  adminRuntime?: AdminRuntime;
  notificationService?: NotificationService;
};

export async function buildApp(options: BuildAppOptions) {
  const telemetry = options.telemetry ?? createDisabledApiTelemetry();
  const requestTelemetry = new WeakMap<FastifyRequest, RequestTelemetryHandle>();
  const deployedEnvironment = options.config.environment !== "local" && options.config.environment !== "test";
  const logger = createLogger(
    {
      environment: options.config.environment,
      level: options.config.logLevel,
      service: "matchday-api",
    },
    options.loggerDestination,
  );
  const app = Fastify({
    genReqId(rawRequest) {
      const candidate = rawRequest.headers["x-request-id"];
      return typeof candidate === "string" && requestIdPattern.test(candidate) ? candidate : randomUUID();
    },
    // Default Fastify request logs include the raw URL. OIDC callbacks carry a one-time code in
    // their query string, so all request completion logs are emitted below from the query-free route.
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: logger,
    trustProxy: options.config.api.trustedProxies.length > 0 ? [...options.config.api.trustedProxies] : false,
  }).withTypeProvider<TypeBoxTypeProvider>();
  let identityRequests: IdentityRequestContext | undefined;
  if (options.identityRuntime) {
    identityRequests =
      options.identityRuntime instanceof IdentityAssuranceRuntime
        ? new IdentityAssuranceRequestContext(options.identityRuntime, options.config.identity.sessionCookieName)
        : createIdentityRequestContext(options.identityRuntime, options.config.identity.sessionCookieName);
  }

  const requestRoute = (request: FastifyRequest): string =>
    request.routeOptions.url || request.url.split("?", 1)[0] || "unknown";

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.url.startsWith("/api/v1/billing/webhook")) {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const rawBuffer = Buffer.concat(chunks);
      (request as unknown as { rawBody: string }).rawBody = rawBuffer.toString("utf8");
      const { Readable } = await import("node:stream");
      return Readable.from([rawBuffer]);
    }
    return payload;
  });

  app.addHook("onRequest", (request, _reply, done) => {
    const traceparent = request.raw.headers.traceparent;
    const tracestate = request.raw.headers.tracestate;
    const handle = telemetry.startRequest({
      headers: {
        ...(typeof traceparent === "string" ? { traceparent } : {}),
        ...(typeof tracestate === "string" ? { tracestate } : {}),
      },
      method: request.method,
      path: request.url.split("?", 1)[0] || "/",
      requestId: request.id,
      route: requestRoute(request),
    });
    requestTelemetry.set(request, handle);
    handle.run(done);
  });

  app.addHook("onError", async (request, _reply, error) => {
    await requestTelemetry.get(request)?.reportError(error);
  });

  app.addHook("onResponse", async (request, reply) => {
    requestTelemetry.get(request)?.finish(reply.statusCode, requestRoute(request));
    request.log.info(
      {
        method: request.method,
        request_id: request.id,
        route: requestRoute(request),
        status_code: reply.statusCode,
        elapsed_ms: reply.elapsedTime,
      },
      "request completed",
    );
    requestTelemetry.delete(request);
  });

  app.addHook("onRequestAbort", async (request) => {
    requestTelemetry.get(request)?.finish(499, requestRoute(request));
    requestTelemetry.delete(request);
  });

  app.addHook("onTimeout", async (request) => {
    requestTelemetry.get(request)?.finish(504, requestRoute(request));
    requestTelemetry.delete(request);
  });

  app.addHook("onClose", async () => telemetry.shutdown());
  if (options.closeIdentityResources) app.addHook("onClose", options.closeIdentityResources);

  await app.register(swagger, {
    openapi: {
      info: { title: "MATCHDAY API", version: "1.0.0" },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: options.config.identity.sessionCookieName,
          },
          providerEventSignature: {
            type: "apiKey",
            in: "header",
            name: "x-matchday-provider-signature",
          },
          scoringSession: {
            type: "apiKey",
            in: "header",
            name: "x-scoring-session-token",
          },
        },
      },
    },
  });

  if (!deployedEnvironment) {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      callback(null, options.config.api.allowedOrigins.includes(origin));
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    frameguard: { action: "deny" },
    hsts: deployedEnvironment
      ? {
          includeSubDomains: true,
          maxAge: options.config.environment === "production" ? 31_536_000 : 63_072_000,
          preload: true,
        }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  const scoringSessionAuthorisedRateLimitRoutes = new Set([
    "GET /api/v1/scoring/session",
    "POST /api/v1/scoring/events",
    "POST /api/v1/scoring/finalise",
    "POST /api/v1/scoring/offline-authorizations",
    "POST /api/v1/scoring/sessions/heartbeat",
    "POST /api/v1/scoring/offline-authorizations/:authorizationId/resume",
    "DELETE /api/v1/scoring/offline-authorizations/:authorizationId",
    "POST /api/v1/scoring/sessions/lease-takeover",
  ]);

  await app.register(rateLimit, {
    global: true,
    hook: "preHandler",
    keyGenerator: async (request) => {
      const accountId = options.resolveRateLimitAccountId
        ? await options.resolveRateLimitAccountId(request)
        : await identityRequests?.rateLimitAccountId(request);
      if (accountId) return `account:${accountId}`;
      const route = `${request.method} ${request.routeOptions.url}`;
      if (scoringSessionAuthorisedRateLimitRoutes.has(route)) {
        const scoringAccessPassId = await options.phase2Runtime?.scoringSessionRateLimitSubject(
          request.headers["x-scoring-session-id"],
          request.headers["x-scoring-session-token"],
        );
        if (scoringAccessPassId) return `scoring-access-pass:${scoringAccessPassId}`;
      }
      return `ip:${request.ip}`;
    },
    max: async (_request, key) =>
      key.startsWith("account:") || key.startsWith("scoring-access-pass:")
        ? (options.authenticatedRateLimitMax ?? options.rateLimitMax ?? 1_000)
        : (options.anonymousRateLimitMax ?? options.rateLimitMax ?? 100),
    ...(options.rateLimitRedis ? { redis: options.rateLimitRedis } : {}),
    ...(options.rateLimitNameSpace ? { nameSpace: options.rateLimitNameSpace } : {}),
    timeWindow: "1 minute",
  });

  if (options.rateLimitRedis) {
    app.addHook("onClose", async () => {
      if (options.rateLimitRedis?.status !== "end") await options.rateLimitRedis?.quit();
    });
  }

  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header(
      "Permissions-Policy",
      deployedEnvironment ? "camera=(), microphone=(), geolocation=()" : "camera=(self), microphone=(), geolocation=()",
    );
    const route = request.routeOptions.url || request.url.split("?", 1)[0] || "";
    if (
      route.startsWith("/api/v1/identity/") ||
      route.startsWith("/api/v1/competitions/") ||
      route.startsWith("/api/v1/organisations/") ||
      route.startsWith("/api/v1/format-revisions/") ||
      route.startsWith("/api/v1/schedule-jobs/") ||
      route.startsWith("/api/v1/schedule-revisions/") ||
      route.startsWith("/api/v1/scoring/") ||
      route.includes("/access-passes")
    ) {
      reply.header("Cache-Control", "no-store, private");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Origin, Cookie");
    } else if (route.startsWith("/api/v1/public/")) {
      reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    const envelope: ApiErrorEnvelope = {
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found", request_id: request.id },
    };
    return reply.code(404).send(envelope);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const apiError = error instanceof ApiError ? error : null;
    const mappedIdentityError = identityErrorMapping(error);
    const isValidationError = typeof error === "object" && error !== null && "validation" in error;
    const frameworkStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : null;
    const statusCode =
      apiError?.statusCode ?? mappedIdentityError?.statusCode ?? (isValidationError ? 400 : (frameworkStatus ?? 500));
    const code =
      apiError?.code ??
      mappedIdentityError?.code ??
      (isValidationError
        ? "VALIDATION_ERROR"
        : statusCode === 429
          ? "RATE_LIMITED"
          : statusCode < 500
            ? "REQUEST_REJECTED"
            : "INTERNAL_ERROR");
    const message =
      apiError?.message ??
      mappedIdentityError?.message ??
      (isValidationError
        ? "Request validation failed"
        : statusCode === 429
          ? "Rate limit exceeded"
          : statusCode < 500
            ? "Request rejected"
            : "An unexpected error occurred");
    if (statusCode >= 500) {
      const correlation = requestTelemetry.get(request)?.correlation;
      request.log.error(
        {
          err: error,
          request_id: request.id,
          ...(correlation?.traceId ? { trace_id: correlation.traceId } : {}),
          ...(correlation?.spanId ? { span_id: correlation.spanId } : {}),
        },
        "request failed",
      );
    }
    const envelope: ApiErrorEnvelope = { error: { code, message, request_id: request.id } };
    return reply.code(statusCode).send(envelope);
  });

  app.get(
    "/health/live",
    {
      schema: {
        description: "Process liveness; deliberately independent of downstream dependencies.",
        response: { 200: healthSchema },
        tags: ["health"],
      },
      config: { rateLimit: false },
    },
    async (request) => healthPayload(request, "healthy"),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        description: "Readiness for API traffic.",
        response: { 200: readinessSchema, 503: readinessSchema },
        tags: ["health"],
      },
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const dependencies = await dependencyStatus(options.probes);
      const ready = Object.values(dependencies).every(Boolean);
      return reply.code(ready ? 200 : 503).send({
        ...healthPayload(request, ready ? "healthy" : "unhealthy"),
        dependencies,
      });
    },
  );

  app.get(
    "/health/deep",
    {
      schema: {
        description: "Internal dependency detail. Deployed ingress must not expose this route without its secret.",
        headers: Type.Object({ "x-deep-health-token": Type.Optional(Type.String()) }),
        response: { 200: readinessSchema, 404: errorSchema, 503: readinessSchema },
        tags: ["health"],
      },
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const token = request.headers["x-deep-health-token"];
      const invalidDeployedAccess =
        deployedEnvironment && (!options.config.deepHealthToken || token !== options.config.deepHealthToken);
      const invalidLocalAccess =
        !deployedEnvironment && Boolean(options.config.deepHealthToken) && token !== options.config.deepHealthToken;
      if (invalidDeployedAccess || invalidLocalAccess) {
        throw new ApiError(404, ErrorCode.ROUTE_NOT_FOUND, "Route not found");
      }
      const dependencies = await dependencyStatus(options.probes);
      const ready = Object.values(dependencies).every(Boolean);
      return reply.code(ready ? 200 : 503).send({
        ...healthPayload(request, ready ? "healthy" : "degraded"),
        dependencies,
      });
    },
  );

  app.get(
    "/api/v1/status",
    {
      schema: {
        description: "Versioned API contract status.",
        headers: Type.Object({ "accept-version": Type.Optional(Type.Literal("1")) }),
        response: {
          200: Type.Object({
            api_version: Type.Literal("v1"),
            request_id: Type.String(),
            status: Type.Literal("available"),
          }),
        },
        tags: ["system"],
      },
    },
    async (request) => ({ api_version: "v1" as const, request_id: request.id, status: "available" as const }),
  );

  if (options.identityRuntime && identityRequests) {
    const oidc = options.config.identity.oidc;
    await registerIdentityRoutes(app as unknown as FastifyInstance, {
      runtime: options.identityRuntime,
      requests: identityRequests,
      allowedOrigins: options.config.api.allowedOrigins,
      cookie: {
        name: options.config.identity.sessionCookieName,
        secure: options.config.identity.secureCookies,
      },
      legacyDirectExchange:
        options.config.identity.provider === "disabled" &&
        (options.config.environment === "local" || options.config.environment === "test"),
      ...(oidc
        ? {
            oidc: {
              callbackUri: oidc.callbackUri,
              flowCookieName: options.config.identity.flowCookieName,
              hostedRecoveryUrl: oidc.hostedRecoveryUrl,
              postAuthRedirectUris: options.config.identity.postAuthRedirectUris,
              sealer: new IdentityFlowSealer(oidc.flowSealKey),
            },
            providerEvents: {
              verifier: new IdentityProviderEventVerifier(
                oidc.providerEventHmacSecret,
                oidc.issuer,
                options.identityProviderEventClock ?? systemClock,
              ),
            },
          }
        : {}),
    });
    if (options.phase2Runtime) {
      await registerPhase2Routes(app as unknown as FastifyInstance, {
        runtime: options.phase2Runtime,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
        ...(options.phase3Runtime ? { phase3Runtime: options.phase3Runtime } : {}),
      });
    }
    if (options.phase3Runtime) {
      await registerPhase3Routes(app as unknown as FastifyInstance, {
        runtime: options.phase3Runtime,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
        ...(!options.phase2Runtime ? { registerCanonicalMutations: true } : {}),
      });
      await registerOrganiserCompetitionLibraryRoutes(app as unknown as FastifyInstance, {
        runtime: options.phase3Runtime,
        identityRequests,
      });
    }
    if (options.phase4Runtime) {
      await registerPhase4Routes(app as unknown as FastifyInstance, {
        runtime: options.phase4Runtime,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
        ...(options.config.deepHealthToken ? { deepHealthToken: options.config.deepHealthToken } : {}),
      });
      if (options.phase4Runtime instanceof GateBPhase4Runtime) {
        await registerPhase4SetupPatchRoutes(app as unknown as FastifyInstance, {
          runtime: options.phase4Runtime,
          identityRuntime: options.identityRuntime,
          identityRequests,
          allowedOrigins: options.config.api.allowedOrigins,
        });
      }
    }
    if (options.scoringAccessHmacKeySql) {
      await registerScoringAccessHmacKeyringRoutes(app as unknown as FastifyInstance, {
        sql: options.scoringAccessHmacKeySql,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
      });
    }
    if (options.scoringFallbackHmacKeySql && options.scoringFallbackHmacKeyring) {
      await registerScoringFallbackHmacKeyringRoutes(app as unknown as FastifyInstance, {
        sql: options.scoringFallbackHmacKeySql,
        configuredKeyring: options.scoringFallbackHmacKeyring,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
      });
    }
    if (options.gateCC4Runtime && options.gateCC4Operations && options.gateCC4Lifecycle) {
      await registerGateCC4Routes(app as unknown as FastifyInstance, {
        runtime: options.gateCC4Runtime,
        operations: options.gateCC4Operations,
        lifecycle: options.gateCC4Lifecycle,
        identityRuntime: options.identityRuntime,
        identityRequests,
        allowedOrigins: options.config.api.allowedOrigins,
      });
    }
    if (options.entitlementRuntime) {
      await registerBillingRoutes(app as unknown as FastifyInstance, {
        runtime: options.entitlementRuntime,
        identityRequests,
      });
    }
    if (options.adminRuntime) {
      await registerAdminRoutes(app as unknown as FastifyInstance, {
        runtime: options.adminRuntime,
        identityRequests,
      });
    }
    if (options.notificationService) {
      await registerNotificationRoutes(app as unknown as FastifyInstance, {
        notificationService: options.notificationService,
        identityRequests,
      });
    }
  }

  if (options.gateCC4PublicTruthRuntime) {
    await registerGateCC4PublicTruthRoutes(app as unknown as FastifyInstance, {
      runtime: options.gateCC4PublicTruthRuntime,
    });
  }

  if (options.exportRuntime) {
    await registerExportRoutes(app as unknown as FastifyInstance, {
      runtime: options.exportRuntime,
      identityRequests,
    });
  }

  await app.ready();
  return app;
}
