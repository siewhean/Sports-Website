import { randomUUID } from "node:crypto";
import { loadConfig, safeConfigSummary } from "@matchday/config";
import { parseAuthenticationAssurancePolicy } from "@matchday/config/authentication-assurance";
import { systemClock, type PostgresJsSql } from "@matchday/identity";
import { Redis } from "ioredis";
import postgres from "postgres";
import {
  DomainScheduleOptimizer,
  PostgresScheduleJobStore,
  ScheduleJobQueue,
  SchedulerRuntime,
  schedulerQueueName,
} from "@matchday/scheduler";
import { buildApp } from "./app.js";
import { startServer } from "./lifecycle.js";
import { PostgresIdentityUnitOfWork } from "./identity-postgres.js";
import { IdentityAssuranceRuntime } from "./identity-assurance-runtime.js";
import { UnavailableIdentityProvider } from "./identity-runtime.js";
import { createOidcIdentityProvider } from "./oidc-provider.js";
import { createDependencyProbes } from "./probes.js";
import { phase2DomainAdapter } from "./phase-2-domain-adapter.js";
import { Phase2Runtime } from "./phase-2-runtime.js";
import { RedisScoringAccessRateLimiter } from "./scoring-access-rate-limit.js";
import { phase3DomainAdapter } from "./phase-3-domain-adapter.js";
import { V1Phase3Runtime } from "./phase-3-v1-runtime.js";
import { phase4AiProviderFromEnvironment } from "./phase-4-ai-provider.js";
import { V1Phase4Runtime } from "./phase-4-v1-runtime.js";
import { startApiTelemetry } from "./telemetry.js";

const MFA_ACR = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

function assuranceClaimName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new Error("IDENTITY_OIDC_ASSURANCE_CLAIM must be a namespaced HTTPS URI");
  }
  return url.href;
}

const config = loadConfig();
const deployedEnvironment = config.environment !== "local" && config.environment !== "test";
if (deployedEnvironment && !process.env.IDENTITY_ASSURANCE_POLICY) {
  throw new Error("IDENTITY_ASSURANCE_POLICY must be explicitly configured in deployed environments");
}
const assurancePolicy = parseAuthenticationAssurancePolicy(
  process.env.IDENTITY_ASSURANCE_POLICY,
  process.env.IDENTITY_ASSURANCE_MAX_AGE_SECONDS,
);
const oidcAssuranceClaim = assuranceClaimName(process.env.IDENTITY_OIDC_ASSURANCE_CLAIM);
const authorizationAcrValues = assurancePolicy.minimum === "off" ? undefined : ([MFA_ACR] as const);
const maxAuthenticationAgeSeconds =
  assurancePolicy.maxAuthenticationAgeMs === undefined
    ? undefined
    : Math.floor(assurancePolicy.maxAuthenticationAgeMs / 1_000);
const identityProvider = config.identity.oidc
  ? await createOidcIdentityProvider({
      issuer: config.identity.oidc.issuer,
      clientId: config.identity.oidc.clientId,
      clientSecret: config.identity.oidc.clientSecret,
      callbackUri: config.identity.oidc.callbackUri,
      allowInsecureLoopback: config.environment === "local" || config.environment === "test",
      ...(oidcAssuranceClaim ? { assuranceClaimName: oidcAssuranceClaim } : {}),
      ...(authorizationAcrValues ? { authorizationAcrValues } : {}),
      ...(maxAuthenticationAgeSeconds !== undefined ? { maxAuthenticationAgeSeconds } : {}),
    })
  : new UnavailableIdentityProvider();
const telemetry = await startApiTelemetry(config);
const rateLimitRedis = new Redis(config.redisUrl, {
  connectTimeout: 2_000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const postgresClient = postgres(config.databaseUrl, { max: 10, onnotice: () => undefined });
const identitySql = postgresClient as unknown as PostgresJsSql;
const identityRuntime = new IdentityAssuranceRuntime(
  identityProvider,
  new PostgresIdentityUnitOfWork(identitySql),
  config.identity.csrfHmacSecret,
  systemClock,
  assurancePolicy,
);
const phase2Runtime = new Phase2Runtime(
  identitySql,
  phase2DomainAdapter,
  undefined,
  new RedisScoringAccessRateLimiter(
    rateLimitRedis,
    config.scoringAccess.rateLimitHmacSecret,
    `matchday:${config.environment}:scoring-access:`,
  ),
  config.scoringAccess.fallbackCodeHmacSecret,
);
const phase3Runtime = new V1Phase3Runtime(identitySql, phase3DomainAdapter);
const queueName = schedulerQueueName(config.environment);
const inlineScheduler = new SchedulerRuntime({
  queueName,
  redisUrl: config.redisUrl,
  workerId: `api-v1-${process.pid}-${randomUUID()}`,
  store: new PostgresScheduleJobStore(postgresClient),
  optimizer: new DomainScheduleOptimizer({ maxIterationsPerRun: 64 }),
  concurrency: 1,
  shutdownTimeoutMs: 30_000,
});
await inlineScheduler.start();
const scheduleQueue = new ScheduleJobQueue({
  queueName,
  redisUrl: config.redisUrl,
});
const phase4Runtime = new V1Phase4Runtime(
  identitySql,
  phase3Runtime,
  scheduleQueue,
  phase4AiProviderFromEnvironment(config.environment),
  undefined,
  phase2Runtime,
);
const app = await buildApp({
  config,
  probes: createDependencyProbes(config),
  rateLimitRedis,
  telemetry,
  identityRuntime,
  phase2Runtime,
  phase3Runtime,
  phase4Runtime,
  closeIdentityResources: async () => {
    await Promise.all([inlineScheduler.stop(), scheduleQueue.close(), postgresClient.end({ timeout: 5 })]);
  },
}).catch(async (error: unknown) => {
  await Promise.allSettled([
    inlineScheduler.stop(),
    rateLimitRedis.quit(),
    scheduleQueue.close(),
    postgresClient.end({ timeout: 1 }),
    telemetry.shutdown(),
  ]);
  throw error;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error }, "api failed to shut down cleanly");
      process.exitCode = 1;
    }
  });
}

try {
  await startServer({
    close: () => app.close(),
    listen: () => app.listen({ host: config.api.host, port: config.api.port }),
    onCloseError: (error) => app.log.error({ err: error }, "api cleanup failed"),
    onListenError: (error) => app.log.fatal({ err: error }, "api failed to start"),
  });
  app.log.info(
    {
      config: safeConfigSummary(config),
      authentication_assurance: {
        minimum: assurancePolicy.minimum,
        max_authentication_age_seconds: maxAuthenticationAgeSeconds ?? null,
        oidc_assurance_claim_configured: Boolean(oidcAssuranceClaim),
      },
    },
    "api started",
  );
} catch {
  process.exitCode = 1;
}
