import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvContent, validateProductionConfig } from "./validate-production-config.mjs";

test("validateProductionConfig accepts valid production configuration", () => {
  const valid = {
    OCI_PUBLIC_HOSTNAME: "matchday.poladex.shop",
    APP_ENV: "production",
    NODE_ENV: "production",
    API_ALLOWED_ORIGINS: "https://matchday.poladex.shop",
    MATCHDAY_PUBLIC_ORIGIN: "https://matchday.poladex.shop",
    SCORING_SESSION_SEAL_KEY: "a".repeat(43),
    POSTGRES_DB: "matchday_prod",
    POSTGRES_USER: "matchday_prod",
    POSTGRES_PASSWORD: "secretpassword123",
    REDIS_PASSWORD: "redispassword123",
    DEEP_HEALTH_TOKEN: "b".repeat(32),
    IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
    IDENTITY_FLOW_SEAL_KEY: "d".repeat(43),
    SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "e".repeat(32),
    SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "f".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@matchday.poladex.shop>",
  };

  const res = validateProductionConfig(valid);
  assert.equal(res.valid, true);
});

test("validateProductionConfig rejects CHANGE_ME placeholders", () => {
  const invalid = {
    OCI_PUBLIC_HOSTNAME: "matchday.poladex.shop",
    APP_ENV: "production",
    NODE_ENV: "production",
    API_ALLOWED_ORIGINS: "https://matchday.poladex.shop",
    MATCHDAY_PUBLIC_ORIGIN: "https://matchday.poladex.shop",
    SCORING_SESSION_SEAL_KEY: "CHANGE_ME",
    POSTGRES_DB: "matchday_prod",
    POSTGRES_USER: "matchday_prod",
    POSTGRES_PASSWORD: "CHANGE_ME",
    REDIS_PASSWORD: "redispassword123",
    DEEP_HEALTH_TOKEN: "b".repeat(32),
    IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
    IDENTITY_FLOW_SEAL_KEY: "d".repeat(43),
    SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "e".repeat(32),
    SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "f".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@matchday.poladex.shop>",
  };

  assert.throws(() => validateProductionConfig(invalid), /contains unresolved placeholder CHANGE_ME/);
});

test("validateProductionConfig rejects staging hostname in production", () => {
  const invalid = {
    OCI_PUBLIC_HOSTNAME: "c5-drill.poladex.shop",
    APP_ENV: "production",
    NODE_ENV: "production",
    API_ALLOWED_ORIGINS: "https://c5-drill.poladex.shop",
    MATCHDAY_PUBLIC_ORIGIN: "https://c5-drill.poladex.shop",
    SCORING_SESSION_SEAL_KEY: "a".repeat(43),
    POSTGRES_DB: "matchday_prod",
    POSTGRES_USER: "matchday_prod",
    POSTGRES_PASSWORD: "secretpassword123",
    REDIS_PASSWORD: "redispassword123",
    DEEP_HEALTH_TOKEN: "b".repeat(32),
    IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
    IDENTITY_FLOW_SEAL_KEY: "d".repeat(43),
    SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "e".repeat(32),
    SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "f".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@c5-drill.poladex.shop>",
  };

  assert.throws(() => validateProductionConfig(invalid), /must not point to staging hostname c5-drill/);
});
