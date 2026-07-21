import { parseConfig } from "@matchday/config";
import { buildApp } from "../src/app.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { Phase4Runtime } from "../src/phase-4-runtime.js";

export async function generateOpenApiDocument() {
  const config = parseConfig({
    APP_ENV: "staging",
    API_ALLOWED_ORIGINS: "https://app.matchday.example",
    LOG_LEVEL: "silent",
    IDENTITY_CSRF_HMAC_SECRET: "o".repeat(32),
    IDENTITY_PROVIDER: "oidc",
    IDENTITY_OIDC_ISSUER: "https://identity.matchday.example",
    IDENTITY_OIDC_CLIENT_ID: "openapi-client",
    IDENTITY_OIDC_CLIENT_SECRET: "openapi-client-secret",
    IDENTITY_OIDC_CALLBACK_URI: "https://api.matchday.example/api/v1/identity/callback",
    IDENTITY_FLOW_SEAL_KEY: Buffer.alloc(32, 19).toString("base64url"),
    IDENTITY_PROVIDER_EVENT_HMAC_SECRET: "openapi-provider-event-secret-at-least-32",
    IDENTITY_COOKIE_SITE: "https://matchday.example",
    IDENTITY_POST_AUTH_REDIRECT_URIS: "https://app.matchday.example/organiser",
    IDENTITY_HOSTED_RECOVERY_URL: "https://identity.matchday.example/recover",
  });
  const identityRuntime = new IdentityApiRuntime(
    new UnavailableIdentityProvider(),
    {
      run: async () => {
        throw new Error("OpenAPI generation must not execute identity persistence.");
      },
    },
    config.identity.csrfHmacSecret,
    { now: () => new Date(0) },
  );
  const sql = {
    unsafe: async () => {
      throw new Error("OpenAPI generation must not execute Phase 4 persistence.");
    },
  };
  const phase3Runtime = new Phase3Runtime(sql, phase3DomainAdapter);
  const app = await buildApp({
    config,
    probes: {
      database: async () => true,
      queue: async () => true,
      redis: async () => true,
    },
    identityRuntime,
    phase2Runtime: new Phase2Runtime(
      {
        unsafe: async () => {
          throw new Error("OpenAPI generation must not execute Phase 2 persistence.");
        },
      },
      phase2DomainAdapter,
    ),
    phase3Runtime,
    phase4Runtime: new Phase4Runtime(
      sql,
      phase3Runtime,
      {
        enqueueSchedule: async () => {
          throw new Error("OpenAPI generation must not enqueue schedule jobs.");
        },
      },
      { mode: "disabled", provider: null, timeoutMs: 8_000, maximumAttempts: 3, cacheTtlSeconds: 86_400 },
    ),
  });
  try {
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
