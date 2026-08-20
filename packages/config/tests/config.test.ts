import { describe, expect, it } from "vitest";
import { parseConfig, safeConfigSummary } from "../src/index.js";

const flowSealKey = Buffer.alloc(32, 7).toString("base64url");
const legacyV1MaterialCommitment = "a".repeat(64);
const oidcConfig = {
  MATCHDAY_PUBLIC_ORIGIN: "https://app.matchday.example",
  SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
    primary: { version: "v1", secret: "scoring-access-rate-limit-secret-32" },
    verificationOnly: [],
  }),
  SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT: legacyV1MaterialCommitment,
  SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "scoring-access-fallback-code-secret-32",
  API_ALLOWED_ORIGINS: "https://app.matchday.example",
  IDENTITY_PROVIDER: "oidc",
  IDENTITY_OIDC_ISSUER: "https://identity.matchday.example",
  IDENTITY_OIDC_CLIENT_ID: "matchday-web",
  IDENTITY_OIDC_CLIENT_SECRET: "provider-secret-at-least-32-bytes-long",
  IDENTITY_OIDC_CALLBACK_URI: "https://api.matchday.example/api/v1/identity/callback",
  IDENTITY_FLOW_SEAL_KEY: flowSealKey,
  IDENTITY_PROVIDER_EVENT_HMAC_SECRET: "provider-event-secret-at-least-32-bytes",
  IDENTITY_COOKIE_SITE: "https://matchday.example",
  IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.matchday.example/organiser",
};
const edgeCacheConfig = {
  EDGE_CACHE_PURGE_ENDPOINT: "https://edge-bridge.matchday.example/purge",
  EDGE_CACHE_PURGE_BEARER_TOKEN: "e".repeat(32),
};

describe("configuration", () => {
  it("provides safe local defaults", () => {
    const config = parseConfig({});
    expect(config.environment).toBe("local");
    expect(config.api.allowedOrigins).toEqual(["http://127.0.0.1:3000", "http://localhost:3000"]);
    expect(config.api.trustedProxies).toEqual([]);
    expect(config.telemetry).toEqual({ enabled: false, metricExportIntervalMs: 10_000 });
    expect(config.identity).toMatchObject({ sessionCookieName: "matchday_session", secureCookies: false });
    expect(config.scoringAccess.rateLimitHmacKeyring.primary).toMatchObject({ version: "v1" });
    expect(config.scoringAccess.rateLimitHmacKeyring.primary.secret).toHaveLength(34);
    expect(config.scoringAccess.fallbackCodeHmacSecret).toHaveLength(36);
  });

  it("requires explicit production dependencies and health protection", () => {
    expect(() => parseConfig({ APP_ENV: "production" })).toThrow("DATABASE_URL");
  });

  it("rejects wildcard and insecure production origins", () => {
    const base = {
      APP_ENV: "production",
      DATABASE_URL: "postgres://user:secret@db.internal/matchday",
      REDIS_URL: "redis://cache.internal:6379",
      DEEP_HEALTH_TOKEN: "a".repeat(32),
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
      ...edgeCacheConfig,
      ...oidcConfig,
    };
    expect(() => parseConfig({ ...base, API_ALLOWED_ORIGINS: "*" })).toThrow("Wildcard");
    expect(() => parseConfig({ ...base, API_ALLOWED_ORIGINS: "http://matchday.example" })).toThrow("HTTPS");
    expect(() => parseConfig({ API_ALLOWED_ORIGINS: "ftp://localhost" })).toThrow("HTTP or HTTPS");
  });

  it("rejects non-origin CORS values without reflecting embedded credentials", () => {
    const invalidOrigins = [
      "https://user:origin-password@app.example.test",
      "https://app.example.test/path",
      "https://app.example.test?tenant=other",
      "https://app.example.test/#fragment",
    ];

    for (const origin of invalidOrigins) {
      let thrown: unknown;
      try {
        parseConfig({ API_ALLOWED_ORIGINS: origin });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain("canonical origins");
      expect(String(thrown)).not.toContain("origin-password");
    }
  });

  it("redacts credentials from diagnostic summaries", () => {
    const summary = safeConfigSummary(parseConfig({ DATABASE_URL: "postgres://owner:secret@localhost/matchday" }));
    expect(summary.databaseUrl).not.toContain("owner");
    expect(summary.databaseUrl).not.toContain("secret");
  });

  it("rejects database and cache URLs for incompatible protocols", () => {
    expect(() => parseConfig({ DATABASE_URL: "https://db.example.test/matchday" })).toThrow(
      "DATABASE_URL must use the postgres or postgresql protocol",
    );
    expect(() => parseConfig({ REDIS_URL: "https://cache.example.test" })).toThrow(
      "REDIS_URL must use the redis or rediss protocol",
    );
  });

  it("trusts only explicitly bounded proxy addresses", () => {
    expect(parseConfig({ API_TRUSTED_PROXIES: "10.0.0.10,192.168.0.0/24" }).api.trustedProxies).toEqual([
      "10.0.0.10",
      "192.168.0.0/24",
    ]);
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "0.0.0.0/0" })).toThrow("Unrestricted");
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "::/0" })).toThrow("Unrestricted");
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "10.23.4.5/0" })).toThrow("Unrestricted");
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "2001:db8::/0" })).toThrow("Unrestricted");
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "loopback" })).toThrow("explicit IP");
    expect(() => parseConfig({ API_TRUSTED_PROXIES: "not-an-ip" })).toThrow("explicit IP");
  });

  it("requires a safe explicit endpoint whenever telemetry is enabled", () => {
    expect(() => parseConfig({ OTEL_ENABLED: "true" })).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(() =>
      parseConfig({
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:secret@collector.internal:4318?token=private",
      }),
    ).toThrow("must not include credentials");
    expect(
      parseConfig({
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/",
        OTEL_METRIC_EXPORT_INTERVAL_MS: "2500",
      }).telemetry,
    ).toEqual({
      enabled: true,
      endpoint: "http://127.0.0.1:4318",
      metricExportIntervalMs: 2_500,
    });
  });

  it("requires enabled OTLP telemetry in production", () => {
    const production = {
      APP_ENV: "production",
      DATABASE_URL: "postgres://user:secret@db.internal/matchday",
      REDIS_URL: "redis://cache.internal:6379",
      DEEP_HEALTH_TOKEN: "a".repeat(32),
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
      ...edgeCacheConfig,
      ...oidcConfig,
    };
    expect(() => parseConfig(production)).toThrow("OTEL_ENABLED must be true");
    expect(parseConfig({ ...production, OTEL_ENABLED: "true" }).telemetry.enabled).toBe(true);
    expect(() =>
      parseConfig({
        ...production,
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318",
      }),
    ).toThrow("Production OTLP endpoints must use HTTPS");
  });

  it("requires a private CSRF secret and __Host cookie outside local/test", () => {
    expect(() => parseConfig({ APP_ENV: "staging", MATCHDAY_PUBLIC_ORIGIN: "https://app.matchday.example" })).toThrow(
      "IDENTITY_CSRF_HMAC_SECRET",
    );
    const config = parseConfig({
      APP_ENV: "staging",
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...oidcConfig,
    });
    expect(config.identity).toMatchObject({
      sessionCookieName: "__Host-matchday_session",
      flowCookieName: "__Secure-matchday_oidc",
      secureCookies: true,
    });
    expect(config.identity.oidc?.issuer).toBe("https://identity.matchday.example");
    expect(safeConfigSummary(config)).not.toHaveProperty("identity.csrfHmacSecret");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain("provider-secret-at-least-16");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain(flowSealKey);
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain("provider-event-secret-at-least-32-bytes");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain("scoring-access-rate-limit-secret-32");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain(
      oidcConfig.SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET,
    );
  });

  it("requires and redacts a versioned scoring access rate-limit HMAC keyring outside local/test", () => {
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        ...oidcConfig,
        SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: undefined,
      }),
    ).toThrow("SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING");
    const config = parseConfig({
      APP_ENV: "staging",
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...oidcConfig,
    });
    expect(safeConfigSummary(config).scoringAccess.rateLimitHmacPrimaryVersion).toBe("v1");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain("scoring-access-rate-limit-secret-32");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain(legacyV1MaterialCommitment);
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        ...oidcConfig,
        SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT: undefined,
      }),
    ).toThrow("SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT");
  });

  it("accepts one primary and verification-only keys without exposing material", () => {
    const primary = "p".repeat(32);
    const previous = "q".repeat(32);
    const config = parseConfig({
      APP_ENV: "staging",
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...oidcConfig,
      SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
        primary: { version: "v2", secret: primary },
        verificationOnly: [{ version: "v1", secret: previous }],
      }),
    });
    expect(config.scoringAccess.rateLimitHmacKeyring).toEqual({
      primary: { version: "v2", secret: primary },
      verificationOnly: [{ version: "v1", secret: previous }],
      legacyV1MaterialCommitment,
    });
    const summary = JSON.stringify(safeConfigSummary(config));
    expect(summary).toContain("v2");
    expect(summary).toContain("v1");
    expect(summary).not.toContain(primary);
    expect(summary).not.toContain(previous);
  });

  it("rejects malformed, duplicate, or missing production keyrings without disclosing key material", () => {
    const staging = { APP_ENV: "staging", IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32), ...oidcConfig };
    expect(() => parseConfig({ ...staging, SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: "not-json" })).toThrow(
      "must be valid JSON",
    );
    const duplicateSecret = "d".repeat(32);
    expect(() =>
      parseConfig({
        ...staging,
        SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v2", secret: duplicateSecret },
          verificationOnly: [{ version: "v1", secret: duplicateSecret }],
        }),
      }),
    ).toThrow("must contain one primary");
  });

  it("requires and redacts a dedicated fallback-code HMAC secret outside local/test", () => {
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        ...oidcConfig,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: undefined,
      }),
    ).toThrow("SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET");
    const config = parseConfig({
      APP_ENV: "staging",
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...oidcConfig,
    });
    expect(safeConfigSummary(config).scoringAccess.fallbackCodeHmacSecretConfigured).toBe(true);
    expect(safeConfigSummary(config).scoringAccess.fallbackCodeHmacPrimaryVersion).toBe("v1");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain(
      oidcConfig.SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET,
    );
    expect(() =>
      parseConfig({
        APP_ENV: "test",
        SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v1", secret: "shared-scoring-access-hmac-secret" },
          verificationOnly: [],
        }),
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "shared-scoring-access-hmac-secret",
      }),
    ).toThrow("Scoring access fallback-code and rate-limit HMAC secrets must be different");
  });

  it("enforces cross-secret separation across all key boundaries and keyrings", () => {
    const baseStaging = {
      APP_ENV: "staging",
      DATABASE_URL: "postgres://user:secret@db.internal/matchday",
      REDIS_URL: "redis://cache.internal:6379",
      DEEP_HEALTH_TOKEN: "h".repeat(32),
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...edgeCacheConfig,
      ...oidcConfig,
    };

    // 1. Fallback verification key matches rate-limit primary
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v2", secret: "fallback-code-primary-secret-32-bytes" },
          verificationOnly: [{ version: "v1", secret: "scoring-access-rate-limit-secret-32" }],
        }),
      }),
    ).toThrow("Scoring access fallback-code and rate-limit HMAC secrets must be different");

    // 2. Fallback primary matches identity CSRF key
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "c".repeat(32),
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and identity CSRF key must be different");

    // 3. Fallback primary matches identity flow seal key
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: flowSealKey,
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and identity flow seal key must be different");

    // 4. Fallback primary matches identity provider-event key
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: oidcConfig.IDENTITY_PROVIDER_EVENT_HMAC_SECRET,
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and identity provider-event key must be different");

    // 5. Fallback primary matches OIDC client secret
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: oidcConfig.IDENTITY_OIDC_CLIENT_SECRET,
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and OIDC client secret must be different");

    // 6. Fallback primary matches deep health token
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "h".repeat(32),
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and deep health token must be different");

    // 7. Fallback primary matches edge cache purge token
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: edgeCacheConfig.EDGE_CACHE_PURGE_BEARER_TOKEN,
      }),
    ).toThrow("Scoring access fallback-code HMAC secret and edge cache purge token must be different");

    // 8. Rate-limit primary matches identity CSRF key
    expect(() =>
      parseConfig({
        ...baseStaging,
        SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
          primary: { version: "v1", secret: "c".repeat(32) },
          verificationOnly: [],
        }),
      }),
    ).toThrow("Scoring access rate-limit HMAC secret and identity CSRF key must be different");

    // 9. Positive test: fully distinct secrets across all keys and purposes
    const positiveConfig = parseConfig({
      ...baseStaging,
      SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
        primary: { version: "v2", secret: "distinct-rate-limit-primary-32-chars" },
        verificationOnly: [{ version: "v1", secret: "distinct-rate-limit-verify-32-chars" }],
      }),
      SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
        primary: { version: "v2", secret: "distinct-fallback-primary-32-chars" },
        verificationOnly: [{ version: "v1", secret: "distinct-fallback-verify-32-chars" }],
      }),
      SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "distinct-fallback-primary-32-chars",
    });
    expect(positiveConfig.scoringAccess.rateLimitHmacKeyring.primary.version).toBe("v2");
    expect(positiveConfig.scoringAccess.fallbackCodeHmacKeyring.primary.version).toBe("v2");
    expect(positiveConfig.scoringAccess.fallbackCodeHmacKeyring.verificationOnly).toHaveLength(1);
    const summary = JSON.stringify(safeConfigSummary(positiveConfig));
    expect(summary).not.toContain("distinct-rate-limit-primary-32-chars");
    expect(summary).not.toContain("distinct-fallback-primary-32-chars");
  });

  it("requires a complete OIDC provider outside local/test", () => {
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        MATCHDAY_PUBLIC_ORIGIN: "https://app.matchday.example",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      }),
    ).toThrow("IDENTITY_PROVIDER must be oidc");
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        MATCHDAY_PUBLIC_ORIGIN: "https://app.matchday.example",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        IDENTITY_PROVIDER: "oidc",
        IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.matchday.example/organiser",
      }),
    ).toThrow("IDENTITY_OIDC_ISSUER");
  });

  it("rejects unsafe OIDC endpoints, callbacks, flow keys, and redirect lists", () => {
    expect(() => parseConfig({ APP_ENV: "test", ...oidcConfig, IDENTITY_OIDC_ISSUER: "http://identity.test" })).toThrow(
      "HTTP is allowed only for loopback",
    );
    expect(() =>
      parseConfig({ APP_ENV: "test", ...oidcConfig, IDENTITY_OIDC_CALLBACK_URI: "https://api.matchday.example/other" }),
    ).toThrow("exact /api/v1/identity/callback path");
    expect(() => parseConfig({ APP_ENV: "test", ...oidcConfig, IDENTITY_FLOW_SEAL_KEY: "a".repeat(43) })).toThrow(
      "exactly 32 random bytes",
    );
    expect(() =>
      parseConfig({
        APP_ENV: "test",
        ...oidcConfig,
        IDENTITY_POST_AUTH_REDIRECT_URIS:
          "https://app.matchday.example/organiser,https://app.matchday.example/organiser",
      }),
    ).toThrow("unique exact redirect URIs");
  });

  it("requires every credentialed application origin and callback to share the configured cookie site", () => {
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        ...oidcConfig,
        API_ALLOWED_ORIGINS: "https://unrelated.example",
      }),
    ).toThrow("schemeful IDENTITY_COOKIE_SITE");
    expect(() =>
      parseConfig({
        APP_ENV: "staging",
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        ...oidcConfig,
        IDENTITY_OIDC_CALLBACK_URI: "https://api.other.example/api/v1/identity/callback",
      }),
    ).toThrow("schemeful IDENTITY_COOKIE_SITE");
  });

  it("rejects public suffixes and subdomains as cookie-site boundaries", () => {
    const staging = {
      APP_ENV: "staging",
      IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
      ...oidcConfig,
    };
    expect(() =>
      parseConfig({
        ...staging,
        IDENTITY_COOKIE_SITE: "https://co.uk",
        API_ALLOWED_ORIGINS: "https://app.foo.co.uk",
        IDENTITY_OIDC_CALLBACK_URI: "https://api.bar.co.uk/api/v1/identity/callback",
        IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.foo.co.uk/organiser",
      }),
    ).toThrow("must not be a public suffix or subdomain");
    expect(() =>
      parseConfig({
        ...staging,
        IDENTITY_COOKIE_SITE: "https://api.matchday.example",
        API_ALLOWED_ORIGINS: "https://app.api.matchday.example",
        IDENTITY_OIDC_CALLBACK_URI: "https://api.matchday.example/api/v1/identity/callback",
        IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.api.matchday.example/organiser",
      }),
    ).toThrow("must not be a public suffix or subdomain");
  });

  it("requires complete safe edge purge configuration when enabled", () => {
    expect(() => parseConfig({ EDGE_CACHE_PURGE_ENDPOINT: "https://edge.example.test/purge" })).toThrow(
      "must be configured together",
    );
    expect(() =>
      parseConfig({
        APP_ENV: "test",
        EDGE_CACHE_PURGE_ENDPOINT: "http://edge.example.test/purge",
        EDGE_CACHE_PURGE_BEARER_TOKEN: "e".repeat(32),
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      parseConfig({
        APP_ENV: "test",
        EDGE_CACHE_PURGE_ENDPOINT: "https://edge.example.test/purge?tenant=other",
        EDGE_CACHE_PURGE_BEARER_TOKEN: "e".repeat(32),
      }),
    ).toThrow("query");
    const config = parseConfig(edgeCacheConfig);
    expect(config.edgeCache?.purgeEndpoint).toBe("https://edge-bridge.matchday.example/purge");
    expect(JSON.stringify(safeConfigSummary(config))).not.toContain(edgeCacheConfig.EDGE_CACHE_PURGE_BEARER_TOKEN);
  });
});
