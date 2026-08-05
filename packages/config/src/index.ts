import { isIP } from "node:net";
import { getDomain } from "tldts";
import { z } from "zod";

const environmentSchema = z.enum(["local", "test", "staging", "production"]);
const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const optionalUrlSchema = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
    message: "DATABASE_URL must use the postgres or postgresql protocol",
  });
const redisUrlSchema = z
  .string()
  .url()
  .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
    message: "REDIS_URL must use the redis or rediss protocol",
  });
const identityProviderSchema = z.enum(["disabled", "oidc"]);
const identityRecoveryModeSchema = z.enum(["hosted"]);
const scoringAccessHmacKeyVersionSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u, {
  message: "Scoring access rate-limit HMAC key versions must be lowercase machine identifiers",
});
const scoringAccessHmacKeySchema = z
  .object({
    version: scoringAccessHmacKeyVersionSchema,
    secret: z.string().min(32).max(1_024),
  })
  .strict();
const scoringAccessHmacKeyringSchema = z
  .object({
    primary: scoringAccessHmacKeySchema,
    verificationOnly: z.array(scoringAccessHmacKeySchema).max(7).default([]),
  })
  .strict()
  .superRefine((keyring, context) => {
    const versions = [keyring.primary.version, ...keyring.verificationOnly.map((key) => key.version)];
    const secrets = [keyring.primary.secret, ...keyring.verificationOnly.map((key) => key.secret)];
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: "custom", message: "Scoring access rate-limit HMAC key versions must be unique" });
    }
    if (new Set(secrets).size !== secrets.length) {
      context.addIssue({ code: "custom", message: "Scoring access rate-limit HMAC key material must be unique" });
    }
  });

const rawConfigSchema = z.object({
  APP_ENV: environmentSchema.default("local"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:3000,http://localhost:3000"),
  API_TRUSTED_PROXIES: z.string().default(""),
  DATABASE_URL: databaseUrlSchema.default("postgres://matchday:matchday@127.0.0.1:5432/matchday"),
  REDIS_URL: redisUrlSchema.default("redis://127.0.0.1:6379"),
  SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: z.string().min(32).max(1_024).default("local-test-scoring-access-rate-key"),
  SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).max(16_384).optional(),
  ),
  SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  ),
  SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: z
    .string()
    .min(32)
    .max(1_024)
    .default("local-test-scoring-fallback-code-key"),
  LOG_LEVEL: logLevelSchema.default("info"),
  DEEP_HEALTH_TOKEN: z.string().min(32).optional(),
  IDENTITY_CSRF_HMAC_SECRET: z.string().min(32).max(1_024).default("local-test-csrf-secret-change-me-32"),
  IDENTITY_PROVIDER: identityProviderSchema.default("disabled"),
  IDENTITY_OIDC_ISSUER: optionalUrlSchema,
  IDENTITY_OIDC_CLIENT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).max(512).optional(),
  ),
  IDENTITY_OIDC_CLIENT_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16).max(4_096).optional(),
  ),
  IDENTITY_OIDC_CALLBACK_URI: optionalUrlSchema,
  IDENTITY_FLOW_SEAL_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(43).max(64).optional(),
  ),
  IDENTITY_PROVIDER_EVENT_HMAC_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).max(1_024).optional(),
  ),
  IDENTITY_COOKIE_SITE: optionalUrlSchema,
  IDENTITY_POST_AUTH_REDIRECT_URIS: z
    .string()
    .default("http://127.0.0.1:3000/organiser,http://localhost:3000/organiser"),
  IDENTITY_RECOVERY_MODE: identityRecoveryModeSchema.default("hosted"),
  EDGE_CACHE_PURGE_ENDPOINT: optionalUrlSchema,
  EDGE_CACHE_PURGE_BEARER_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().max(4_096).optional(),
  ),
  OTEL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrlSchema,
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export type AppConfig = {
  environment: AppEnvironment;
  api: {
    host: string;
    port: number;
    allowedOrigins: readonly string[];
    trustedProxies: readonly string[];
  };
  databaseUrl: string;
  redisUrl: string;
  scoringAccess: {
    rateLimitHmacKeyring: {
      primary: { version: string; secret: string };
      verificationOnly: readonly { version: string; secret: string }[];
      legacyV1MaterialCommitment?: string;
    };
    fallbackCodeHmacSecret: string;
  };
  logLevel: z.infer<typeof logLevelSchema>;
  deepHealthToken?: string;
  identity: {
    csrfHmacSecret: string;
    sessionCookieName: string;
    flowCookieName: string;
    secureCookies: boolean;
    provider: z.infer<typeof identityProviderSchema>;
    postAuthRedirectUris: readonly string[];
    oidc?: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      callbackUri: string;
      flowSealKey: string;
      recoveryMode: z.infer<typeof identityRecoveryModeSchema>;
      providerEventHmacSecret: string;
      cookieSite: string;
    };
  };
  edgeCache?: {
    purgeEndpoint: string;
    purgeBearerToken: string;
  };
  telemetry: {
    enabled: boolean;
    endpoint?: string;
    metricExportIntervalMs: number;
  };
};

function requireProductionValue(
  environment: AppEnvironment,
  source: NodeJS.ProcessEnv,
  key: "DATABASE_URL" | "REDIS_URL" | "DEEP_HEALTH_TOKEN" | "API_ALLOWED_ORIGINS" | "OTEL_EXPORTER_OTLP_ENDPOINT",
) {
  if (environment === "production" && !source[key]) {
    throw new Error(`${key} must be explicitly configured in production`);
  }
}

function isIpOrCidr(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  if (!address || extra.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

function validatedIdentityUrl(
  value: string,
  environment: AppEnvironment,
  label: string,
  options: { allowQuery?: boolean; callback?: boolean } = {},
): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (!options.allowQuery && url.search)) {
    throw new Error(
      `${label} must not include credentials${options.allowQuery ? " or a fragment" : ", query, or fragment"}`,
    );
  }
  if (url.protocol !== "https:") {
    const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if ((environment !== "local" && environment !== "test") || !loopback) {
      throw new Error(`${label} must use HTTPS outside local/test and HTTP is allowed only for loopback`);
    }
  }
  if (options.callback && url.pathname !== "/api/v1/identity/callback") {
    throw new Error(`${label} must use the exact /api/v1/identity/callback path`);
  }
  return url.href;
}

function validateFlowSealKey(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("IDENTITY_FLOW_SEAL_KEY must be base64url encoded");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("IDENTITY_FLOW_SEAL_KEY must encode exactly 32 random bytes");
  }
}

function validatedCookieSite(value: string, environment: AppEnvironment): URL {
  const site = new URL(value);
  const loopback = site.hostname === "127.0.0.1" || site.hostname === "localhost";
  if (
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/" ||
    (environment !== "local" && environment !== "test" && site.port)
  ) {
    throw new Error(
      "IDENTITY_COOKIE_SITE must be a scheme and registrable-domain boundary without credentials, port, path, query, or fragment",
    );
  }
  if (site.protocol !== "https:") {
    const insecureLoopback = site.protocol === "http:" && loopback;
    if ((environment !== "local" && environment !== "test") || !insecureLoopback) {
      throw new Error("IDENTITY_COOKIE_SITE must use HTTPS outside local/test");
    }
  }
  if (!loopback) {
    const registrableDomain = getDomain(site.hostname, { allowPrivateDomains: true });
    if (registrableDomain === null || site.hostname !== registrableDomain) {
      throw new Error(
        "IDENTITY_COOKIE_SITE hostname must be exactly one registrable domain and must not be a public suffix or subdomain",
      );
    }
  }
  return site;
}

function requireCookieSite(urlValue: string, site: URL, label: string): void {
  const value = new URL(urlValue);
  const withinHostname = value.hostname === site.hostname || value.hostname.endsWith(`.${site.hostname}`);
  if (value.protocol !== site.protocol || !withinHostname) {
    throw new Error(`${label} must be within the configured schemeful IDENTITY_COOKIE_SITE`);
  }
}

function validatedEdgePurgeUrl(value: string, environment: AppEnvironment): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !((environment === "local" || environment === "test") && loopback)) {
    throw new Error("EDGE_CACHE_PURGE_ENDPOINT must use HTTPS outside local/test");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("EDGE_CACHE_PURGE_ENDPOINT must not include credentials, query, or fragment");
  }
  return url.href;
}

function parseScoringAccessRateLimitHmacKeyring(
  rawKeyring: string | undefined,
  legacySecret: string,
  environment: AppEnvironment,
): AppConfig["scoringAccess"]["rateLimitHmacKeyring"] {
  if (!rawKeyring) {
    if (environment !== "local" && environment !== "test") {
      throw new Error("SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING must be explicitly configured outside local/test");
    }
    return {
      primary: { version: "v1", secret: legacySecret },
      verificationOnly: [],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawKeyring);
  } catch {
    throw new Error("SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING must be valid JSON");
  }
  const parsed = scoringAccessHmacKeyringSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      "SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING must contain one primary key and unique verification-only keys",
    );
  }
  return parsed.data;
}

export function parseConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = rawConfigSchema.parse(source);
  requireProductionValue(parsed.APP_ENV, source, "DATABASE_URL");
  requireProductionValue(parsed.APP_ENV, source, "REDIS_URL");
  requireProductionValue(parsed.APP_ENV, source, "DEEP_HEALTH_TOKEN");
  requireProductionValue(parsed.APP_ENV, source, "API_ALLOWED_ORIGINS");
  requireProductionValue(parsed.APP_ENV, source, "OTEL_EXPORTER_OTLP_ENDPOINT");
  if (parsed.APP_ENV !== "local" && parsed.APP_ENV !== "test" && !source.IDENTITY_CSRF_HMAC_SECRET) {
    throw new Error("IDENTITY_CSRF_HMAC_SECRET must be explicitly configured outside local/test");
  }
  if (parsed.APP_ENV !== "local" && parsed.APP_ENV !== "test" && parsed.IDENTITY_PROVIDER !== "oidc") {
    throw new Error("IDENTITY_PROVIDER must be oidc outside local/test");
  }
  if (parsed.APP_ENV === "production" && !parsed.OTEL_ENABLED) {
    throw new Error("OTEL_ENABLED must be true in production");
  }
  if (Boolean(parsed.EDGE_CACHE_PURGE_ENDPOINT) !== Boolean(parsed.EDGE_CACHE_PURGE_BEARER_TOKEN)) {
    throw new Error("EDGE_CACHE_PURGE_ENDPOINT and EDGE_CACHE_PURGE_BEARER_TOKEN must be configured together");
  }

  const allowedOrigins = parsed.API_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of allowedOrigins) {
    if (origin === "*") throw new Error("Wildcard CORS origins are forbidden");
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CORS origins must use HTTP or HTTPS");
    }
    if (parsed.APP_ENV === "production" && url.protocol !== "https:") {
      throw new Error("Production CORS origins must use HTTPS");
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || origin !== url.origin) {
      throw new Error("CORS origins must be canonical origins without credentials, path, query, or fragment");
    }
  }

  const trustedProxies = parsed.API_TRUSTED_PROXIES.split(",")
    .map((proxy) => proxy.trim())
    .filter(Boolean);
  for (const proxy of trustedProxies) {
    if (proxy.endsWith("/0")) throw new Error("Unrestricted trusted proxy ranges are forbidden");
    if (!isIpOrCidr(proxy)) throw new Error("Trusted proxies must be explicit IP addresses or CIDR ranges");
  }

  const postAuthRedirectUris = parsed.IDENTITY_POST_AUTH_REDIRECT_URIS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => validatedIdentityUrl(value, parsed.APP_ENV, "IDENTITY_POST_AUTH_REDIRECT_URIS"));
  if (postAuthRedirectUris.length === 0 || new Set(postAuthRedirectUris).size !== postAuthRedirectUris.length) {
    throw new Error("IDENTITY_POST_AUTH_REDIRECT_URIS must contain unique exact redirect URIs");
  }

  let oidc: AppConfig["identity"]["oidc"];
  if (parsed.IDENTITY_PROVIDER === "oidc") {
    const required = {
      IDENTITY_OIDC_ISSUER: parsed.IDENTITY_OIDC_ISSUER,
      IDENTITY_OIDC_CLIENT_ID: parsed.IDENTITY_OIDC_CLIENT_ID,
      IDENTITY_OIDC_CLIENT_SECRET: parsed.IDENTITY_OIDC_CLIENT_SECRET,
      IDENTITY_OIDC_CALLBACK_URI: parsed.IDENTITY_OIDC_CALLBACK_URI,
      IDENTITY_FLOW_SEAL_KEY: parsed.IDENTITY_FLOW_SEAL_KEY,
      IDENTITY_PROVIDER_EVENT_HMAC_SECRET: parsed.IDENTITY_PROVIDER_EVENT_HMAC_SECRET,
      IDENTITY_COOKIE_SITE: parsed.IDENTITY_COOKIE_SITE,
    };
    for (const [key, value] of Object.entries(required)) {
      if (!value) throw new Error(`${key} is required when IDENTITY_PROVIDER=oidc`);
    }
    const flowSealKey = required.IDENTITY_FLOW_SEAL_KEY as string;
    validateFlowSealKey(flowSealKey);
    validatedIdentityUrl(required.IDENTITY_OIDC_ISSUER as string, parsed.APP_ENV, "IDENTITY_OIDC_ISSUER");
    const cookieSite = validatedCookieSite(required.IDENTITY_COOKIE_SITE as string, parsed.APP_ENV);
    requireCookieSite(required.IDENTITY_OIDC_CALLBACK_URI as string, cookieSite, "IDENTITY_OIDC_CALLBACK_URI");
    for (const origin of allowedOrigins) requireCookieSite(origin, cookieSite, "API_ALLOWED_ORIGINS");
    for (const redirect of postAuthRedirectUris) {
      requireCookieSite(redirect, cookieSite, "IDENTITY_POST_AUTH_REDIRECT_URIS");
    }
    oidc = {
      issuer: required.IDENTITY_OIDC_ISSUER as string,
      clientId: required.IDENTITY_OIDC_CLIENT_ID as string,
      clientSecret: required.IDENTITY_OIDC_CLIENT_SECRET as string,
      callbackUri: validatedIdentityUrl(
        required.IDENTITY_OIDC_CALLBACK_URI as string,
        parsed.APP_ENV,
        "IDENTITY_OIDC_CALLBACK_URI",
        { callback: true },
      ),
      flowSealKey,
      recoveryMode: parsed.IDENTITY_RECOVERY_MODE,
      providerEventHmacSecret: required.IDENTITY_PROVIDER_EVENT_HMAC_SECRET as string,
      cookieSite: cookieSite.origin,
    };
  }
  const rateLimitHmacKeyring = parseScoringAccessRateLimitHmacKeyring(
    parsed.SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING,
    parsed.SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET,
    parsed.APP_ENV,
  );
  const includesLegacyV1 = [rateLimitHmacKeyring.primary, ...rateLimitHmacKeyring.verificationOnly].some(
    (key) => key.version === "v1",
  );
  if (
    parsed.APP_ENV !== "local" &&
    parsed.APP_ENV !== "test" &&
    includesLegacyV1 &&
    !parsed.SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT
  ) {
    throw new Error(
      "SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT is required while v1 retains C1-C4 rate-limit state",
    );
  }
  if (parsed.APP_ENV !== "local" && parsed.APP_ENV !== "test" && !source.SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET) {
    throw new Error("SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET must be explicitly configured outside local/test");
  }
  if (
    [rateLimitHmacKeyring.primary, ...rateLimitHmacKeyring.verificationOnly].some(
      (key) => key.secret === parsed.SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET,
    )
  ) {
    throw new Error("Scoring access fallback-code and rate-limit HMAC secrets must be different");
  }

  let telemetryEndpoint: string | undefined;
  if (parsed.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const url = new URL(parsed.OTEL_EXPORTER_OTLP_ENDPOINT);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must use HTTP or HTTPS");
    }
    if (parsed.APP_ENV === "production" && url.protocol !== "https:") {
      throw new Error("Production OTLP endpoints must use HTTPS");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must not include credentials, query, or fragment");
    }
    telemetryEndpoint = url.toString().replace(/\/$/, "");
  }
  if (parsed.OTEL_ENABLED && !telemetryEndpoint) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required when telemetry is enabled");
  }

  let edgeCache: AppConfig["edgeCache"];
  if (parsed.EDGE_CACHE_PURGE_ENDPOINT && parsed.EDGE_CACHE_PURGE_BEARER_TOKEN) {
    if (Buffer.byteLength(parsed.EDGE_CACHE_PURGE_BEARER_TOKEN, "utf8") < 32) {
      throw new Error("EDGE_CACHE_PURGE_BEARER_TOKEN must be at least 32 bytes");
    }
    edgeCache = {
      purgeEndpoint: validatedEdgePurgeUrl(parsed.EDGE_CACHE_PURGE_ENDPOINT, parsed.APP_ENV),
      purgeBearerToken: parsed.EDGE_CACHE_PURGE_BEARER_TOKEN,
    };
  }

  return {
    environment: parsed.APP_ENV,
    api: {
      host: parsed.API_HOST,
      port: parsed.API_PORT,
      allowedOrigins,
      trustedProxies,
    },
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    scoringAccess: {
      rateLimitHmacKeyring: {
        ...rateLimitHmacKeyring,
        ...(parsed.SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT
          ? { legacyV1MaterialCommitment: parsed.SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT }
          : {}),
      },
      fallbackCodeHmacSecret: parsed.SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET,
    },
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.DEEP_HEALTH_TOKEN ? { deepHealthToken: parsed.DEEP_HEALTH_TOKEN } : {}),
    identity: {
      csrfHmacSecret: parsed.IDENTITY_CSRF_HMAC_SECRET,
      sessionCookieName:
        parsed.APP_ENV === "local" || parsed.APP_ENV === "test" ? "matchday_session" : "__Host-matchday_session",
      flowCookieName:
        parsed.APP_ENV === "local" || parsed.APP_ENV === "test" ? "matchday_oidc" : "__Secure-matchday_oidc",
      secureCookies: parsed.APP_ENV !== "local" && parsed.APP_ENV !== "test",
      provider: parsed.IDENTITY_PROVIDER,
      postAuthRedirectUris,
      ...(oidc ? { oidc } : {}),
    },
    ...(edgeCache ? { edgeCache } : {}),
    telemetry: {
      enabled: parsed.OTEL_ENABLED,
      metricExportIntervalMs: parsed.OTEL_METRIC_EXPORT_INTERVAL_MS,
      ...(telemetryEndpoint ? { endpoint: telemetryEndpoint } : {}),
    },
  };
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}

function redactUrl(value: string): string {
  const url = new URL(value);
  if (url.username) url.username = "redacted";
  if (url.password) url.password = "redacted";
  return url.toString();
}

export function safeConfigSummary(config: AppConfig) {
  return {
    environment: config.environment,
    api: {
      ...config.api,
      allowedOrigins: config.api.allowedOrigins.map(redactUrl),
    },
    databaseUrl: redactUrl(config.databaseUrl),
    redisUrl: redactUrl(config.redisUrl),
    scoringAccess: {
      rateLimitHmacPrimaryVersion: config.scoringAccess.rateLimitHmacKeyring.primary.version,
      rateLimitHmacVerificationOnlyVersions: config.scoringAccess.rateLimitHmacKeyring.verificationOnly.map(
        (key) => key.version,
      ),
      fallbackCodeHmacSecretConfigured: Boolean(config.scoringAccess.fallbackCodeHmacSecret),
    },
    logLevel: config.logLevel,
    deepHealthTokenConfigured: Boolean(config.deepHealthToken),
    identity: {
      csrfHmacSecretConfigured: Boolean(config.identity.csrfHmacSecret),
      sessionCookieName: config.identity.sessionCookieName,
      flowCookieName: config.identity.flowCookieName,
      secureCookies: config.identity.secureCookies,
      provider: config.identity.provider,
      oidcConfigured: Boolean(config.identity.oidc),
      oidcIssuer: config.identity.oidc?.issuer,
      oidcCallbackUri: config.identity.oidc?.callbackUri,
      postAuthRedirectUris: config.identity.postAuthRedirectUris,
      recoveryMode: config.identity.oidc?.recoveryMode,
      cookieSite: config.identity.oidc?.cookieSite,
      providerEventsConfigured: Boolean(config.identity.oidc?.providerEventHmacSecret),
    },
    edgeCache: {
      configured: Boolean(config.edgeCache),
      purgeEndpoint: config.edgeCache?.purgeEndpoint,
    },
    telemetry: {
      enabled: config.telemetry.enabled,
      endpoint: config.telemetry.endpoint,
      metricExportIntervalMs: config.telemetry.metricExportIntervalMs,
    },
  };
}
