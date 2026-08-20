import { loadConfig, safeConfigSummary } from "@matchday/config";
import { systemClock, type PostgresJsSql } from "@matchday/identity";
import { Redis } from "ioredis";
import postgres from "postgres";
import { ScheduleJobQueue, schedulerQueueName } from "@matchday/scheduler";
import { buildApp } from "./app.js";
import { startServer } from "./lifecycle.js";
import { PostgresIdentityUnitOfWork } from "./identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "./identity-runtime.js";
import { createOidcIdentityProvider } from "./oidc-provider.js";
import { createDependencyProbes } from "./probes.js";
import { phase2DomainAdapter } from "./phase-2-domain-adapter.js";
import { FallbackKeyringPhase2Runtime } from "./phase-2-fallback-keyring-runtime.js";
import { RedisScoringAccessRateLimiter } from "./scoring-access-rate-limit.js";
import { reconcileScoringAccessHmacKeyring } from "./scoring-access-hmac-keyring.js";
import { phase3DomainAdapter } from "./phase-3-domain-adapter.js";
import { Phase3Runtime } from "./phase-3-runtime.js";
import { phase4AiProviderFromEnvironment } from "./phase-4-ai-provider.js";
import { ReliableGateBPhase4Runtime } from "./phase-4-reliable-runtime.js";
import { startApiTelemetry } from "./telemetry.js";

const config = loadConfig();
const fallbackCodeHmacKeyring = config.scoringAccess.fallbackCodeHmacKeyring;
const identityProvider = config.identity.oidc
  ? await createOidcIdentityProvider({
      issuer: config.identity.oidc.issuer,
      clientId: config.identity.oidc.clientId,
      clientSecret: config.identity.oidc.clientSecret,
      callbackUri: config.identity.oidc.callbackUri,
      allowInsecureLoopback: config.environment === "local" || config.environment === "test",
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
await reconcileScoringAccessHmacKeyring(identitySql, config.scoringAccess.rateLimitHmacKeyring);
const identityRuntime = new IdentityApiRuntime(
  identityProvider,
  new PostgresIdentityUnitOfWork(identitySql),
  config.identity.csrfHmacSecret,
  systemClock,
);
const scoringAccessRateLimiter = new RedisScoringAccessRateLimiter(
  rateLimitRedis,
  config.scoringAccess.rateLimitHmacKeyring,
  `matchday:${config.environment}:scoring-access:`,
);
const phase2Runtime = new FallbackKeyringPhase2Runtime(
  identitySql,
  phase2DomainAdapter,
  fallbackCodeHmacKeyring,
  undefined,
  scoringAccessRateLimiter,
);
const phase3Runtime = new Phase3Runtime(identitySql, phase3DomainAdapter);
const scheduleQueue = new ScheduleJobQueue({
  queueName: schedulerQueueName(config.environment),
  redisUrl: config.redisUrl,
});
const publicApplicationOrigin = config.api.allowedOrigins[0];
if (!publicApplicationOrigin) throw new Error("At least one allowed application origin is required");
const phase4Runtime = new ReliableGateBPhase4Runtime(
  identitySql,
  phase3Runtime,
  scheduleQueue,
  phase4AiProviderFromEnvironment(config.environment),
  undefined,
  phase2Runtime,
  phase2Runtime,
  publicApplicationOrigin,
);
const app = await buildApp({
  config,
  probes: createDependencyProbes(config),
  rateLimitRedis,
  telemetry,
  identityRuntime,
  scoringAccessHmacKeySql: identitySql,
  phase2Runtime,
  phase3Runtime,
  phase4Runtime,
  closeIdentityResources: async () => {
    await Promise.all([scheduleQueue.close(), postgresClient.end({ timeout: 5 })]);
  },
}).catch(async (error: unknown) => {
  await Promise.allSettled([
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
      scoring_fallback_hmac: {
        primary_version: fallbackCodeHmacKeyring.primary.version,
        verification_only_versions: fallbackCodeHmacKeyring.verificationOnly.map((key) => key.version),
      },
    },
    "api started",
  );
} catch {
  process.exitCode = 1;
}
