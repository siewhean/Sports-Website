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
import { Phase2Runtime } from "./phase-2-runtime.js";
import { phase3DomainAdapter } from "./phase-3-domain-adapter.js";
import { Phase3Runtime } from "./phase-3-runtime.js";
import { phase4AiProviderFromEnvironment } from "./phase-4-ai-provider.js";
import { Phase4Runtime } from "./phase-4-runtime.js";
import { startApiTelemetry } from "./telemetry.js";

const config = loadConfig();
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
const identityRuntime = new IdentityApiRuntime(
  identityProvider,
  new PostgresIdentityUnitOfWork(identitySql),
  config.identity.csrfHmacSecret,
  systemClock,
);
const phase2Runtime = new Phase2Runtime(identitySql, phase2DomainAdapter);
const phase3Runtime = new Phase3Runtime(identitySql, phase3DomainAdapter);
const scheduleQueue = new ScheduleJobQueue({
  queueName: schedulerQueueName(config.environment),
  redisUrl: config.redisUrl,
});
const phase4Runtime = new Phase4Runtime(
  identitySql,
  phase3Runtime,
  scheduleQueue,
  phase4AiProviderFromEnvironment(config.environment),
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
  app.log.info({ config: safeConfigSummary(config) }, "api started");
} catch {
  process.exitCode = 1;
}
