import { describe, expect, it } from "vitest";
import { parseConfig, safeConfigSummary } from "../src/index.js";

const flowSealKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function staging(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: "staging",
    API_ALLOWED_ORIGINS: "https://app.example.com",
    MATCHDAY_PUBLIC_ORIGIN: "https://app.example.com",
    IDENTITY_CSRF_HMAC_SECRET: "identity-csrf-secret-32-characters-minimum",
    IDENTITY_PROVIDER: "oidc",
    IDENTITY_OIDC_ISSUER: "https://id.example.com",
    IDENTITY_OIDC_CLIENT_ID: "matchday-staging",
    IDENTITY_OIDC_CLIENT_SECRET: "oidc-client-secret-at-least-sixteen",
    IDENTITY_OIDC_CALLBACK_URI: "https://api.example.com/api/v1/identity/callback",
    IDENTITY_FLOW_SEAL_KEY: flowSealKey,
    IDENTITY_PROVIDER_EVENT_HMAC_SECRET: "provider-event-secret-32-characters-minimum",
    IDENTITY_COOKIE_SITE: "https://example.com",
    IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.example.com/organiser",
    SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING: JSON.stringify({
      primary: { version: "v2", secret: "rate-limit-secret-32-characters-minimum" },
      verificationOnly: [],
    }),
    SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "fallback-code-secret-32-characters-minimum",
    ...overrides,
  };
}

describe("MATCHDAY_PUBLIC_ORIGIN configuration", () => {
  it("allows local/test to omit the public origin", () => {
    expect(parseConfig({ APP_ENV: "local" }).publicOrigin).toBeUndefined();
    expect(parseConfig({ APP_ENV: "test" }).publicOrigin).toBeUndefined();
  });

  it("accepts loopback HTTP only in local/test", () => {
    expect(parseConfig({ APP_ENV: "local", MATCHDAY_PUBLIC_ORIGIN: "http://127.0.0.1:3000" }).publicOrigin).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("requires an explicit public origin outside local/test", () => {
    const source = staging();
    delete source.MATCHDAY_PUBLIC_ORIGIN;
    expect(() => parseConfig(source)).toThrow(
      /MATCHDAY_PUBLIC_ORIGIN must be explicitly configured outside local\/test/i,
    );
  });

  it("requires HTTPS and a canonical origin in staging", () => {
    expect(() => parseConfig(staging({ MATCHDAY_PUBLIC_ORIGIN: "http://app.example.com" }))).toThrow(
      /MATCHDAY_PUBLIC_ORIGIN must use HTTPS/i,
    );
    expect(() => parseConfig(staging({ MATCHDAY_PUBLIC_ORIGIN: "https://app.example.com/organiser" }))).toThrow(
      /MATCHDAY_PUBLIC_ORIGIN must be one canonical/i,
    );
  });

  it("requires the public origin to share the configured identity cookie site", () => {
    expect(() => parseConfig(staging({ MATCHDAY_PUBLIC_ORIGIN: "https://app.attacker.test" }))).toThrow(
      /MATCHDAY_PUBLIC_ORIGIN must be within the configured schemeful IDENTITY_COOKIE_SITE/i,
    );
  });

  it("returns and safely summarizes the validated public origin", () => {
    const config = parseConfig(staging());
    expect(config.publicOrigin).toBe("https://app.example.com");
    expect(safeConfigSummary(config).publicOrigin).toBe("https://app.example.com");
  });
});
