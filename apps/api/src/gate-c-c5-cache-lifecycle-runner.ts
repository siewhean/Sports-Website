import { createHash } from "node:crypto";

const STAGING_CONFIRMATION = "C5_DISPOSABLE_STAGING_FIXTURE";

export type GateCC5CacheLifecycleTarget = Readonly<{
  apiOrigin: URL;
  edgeOrigin: URL;
  databaseUrl: string;
  redisUrl: string;
  artifactRoot: string;
}>;

export type GateCC5RedactedCacheLifecycleTarget = Readonly<{
  api_origin_sha256: string;
  edge_origin_sha256: string;
  database_host_sha256: string;
  redis_host_sha256: string;
}>;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function httpsOrigin(name: string, value: string | undefined): URL {
  if (!value) throw new Error(`Gate C C5 cache runner requires ${name}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Gate C C5 cache runner requires ${name} to be a bare trusted HTTPS origin`);
  }
  return url;
}

/** The only target shape permitted in retained logs or receipts. */
export function redactGateCC5CacheLifecycleTarget(
  target: GateCC5CacheLifecycleTarget,
): GateCC5RedactedCacheLifecycleTarget {
  return {
    api_origin_sha256: hash(target.apiOrigin.origin),
    edge_origin_sha256: hash(target.edgeOrigin.origin),
    database_host_sha256: hash(new URL(target.databaseUrl).host),
    redis_host_sha256: hash(new URL(target.redisUrl).host),
  };
}

/**
 * This direct-to-database bootstrap is deliberately unavailable outside a
 * disposable staging deployment. It is not an HTTP route and never creates
 * fixtures in development, test, preview, or production environments.
 */
export function parseGateCC5CacheLifecycleTarget(environment: NodeJS.ProcessEnv): GateCC5CacheLifecycleTarget {
  if (environment.APP_ENV !== "staging") {
    throw new Error("Gate C C5 cache runner is permitted only with APP_ENV=staging");
  }
  if (environment.GATE_C_C5_DISPOSABLE_FIXTURE_CONFIRMATION !== STAGING_CONFIRMATION) {
    throw new Error("Gate C C5 cache runner requires the explicit disposable staging fixture confirmation");
  }
  const databaseUrl = environment.DATABASE_URL;
  const redisUrl = environment.REDIS_URL;
  const artifactRoot = environment.GATE_C_C5_EVIDENCE_DIR;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new Error("Gate C C5 cache runner requires DATABASE_URL");
  }
  if (!redisUrl || !/^rediss?:\/\//u.test(redisUrl)) throw new Error("Gate C C5 cache runner requires REDIS_URL");
  if (!artifactRoot || !artifactRoot.includes("artifacts/qa/gate-c-c5/")) {
    throw new Error("Gate C C5 cache runner requires an exact-SHA artifact root");
  }
  return {
    apiOrigin: httpsOrigin("GATE_C_C5_API_ORIGIN", environment.GATE_C_C5_API_ORIGIN),
    edgeOrigin: httpsOrigin("GATE_C_C5_EDGE_ORIGIN", environment.GATE_C_C5_EDGE_ORIGIN),
    databaseUrl,
    redisUrl,
    artifactRoot,
  };
}

export { STAGING_CONFIRMATION };
