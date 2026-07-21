import { parseConfig } from "@matchday/config";
import { isIP } from "node:net";
import type { DependencyProbes } from "../src/probes.js";

export const healthyProbes: DependencyProbes = {
  database: async () => true,
  queue: async () => true,
  redis: async () => true,
};

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return parseConfig({ APP_ENV: "test", LOG_LEVEL: "silent", ...overrides });
}

export function oidcEnvironment(appOrigin: string, apiOrigin = appOrigin): NodeJS.ProcessEnv {
  const app = new URL(appOrigin);
  const labels = app.hostname.split(".");
  const isLoopbackName = app.hostname === "localhost" || isIP(app.hostname) !== 0;
  const cookieHostname = !isLoopbackName && labels.length >= 3 ? labels.slice(-2).join(".") : app.hostname;
  const cookieSite = `${app.protocol}//${cookieHostname}${isLoopbackName && app.port ? `:${app.port}` : ""}`;
  return {
    API_ALLOWED_ORIGINS: appOrigin,
    IDENTITY_PROVIDER: "oidc",
    IDENTITY_OIDC_ISSUER: "https://identity.matchday.test",
    IDENTITY_OIDC_CLIENT_ID: "matchday-test-client",
    IDENTITY_OIDC_CLIENT_SECRET: "matchday-test-client-secret",
    IDENTITY_OIDC_CALLBACK_URI: `${apiOrigin}/api/v1/identity/callback`,
    IDENTITY_FLOW_SEAL_KEY: Buffer.alloc(32, 11).toString("base64url"),
    IDENTITY_PROVIDER_EVENT_HMAC_SECRET: "provider-event-test-secret-at-least-32-bytes",
    IDENTITY_COOKIE_SITE: cookieSite,
    IDENTITY_POST_AUTH_REDIRECT_URIS: `${appOrigin}/organiser`,
    IDENTITY_HOSTED_RECOVERY_URL: "https://identity.matchday.test/recover",
  };
}

export function edgeCacheEnvironment(): NodeJS.ProcessEnv {
  return {
    EDGE_CACHE_PURGE_ENDPOINT: "https://edge-bridge.matchday.test/purge",
    EDGE_CACHE_PURGE_BEARER_TOKEN: "e".repeat(32),
  };
}
