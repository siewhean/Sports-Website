import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvContent, validateProductionConfig } from "./validate-production-config.mjs";
import { startTelemetryRuntime } from "../packages/observability/src/runtime.ts";

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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@c5-drill.poladex.shop>",
  };

  assert.throws(() => validateProductionConfig(invalid), /must not point to staging hostname c5-drill/);
});

test("validateProductionConfig accepts OTEL_ENABLED=false without endpoint", () => {
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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@matchday.poladex.shop>",
    OTEL_ENABLED: "false",
  };

  const res = validateProductionConfig(valid);
  assert.equal(res.valid, true);
});

test("validateProductionConfig accepts OTEL_ENABLED=true with HTTPS non-loopback endpoint", () => {
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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@matchday.poladex.shop>",
    OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel-collector.internal:4318",
  };

  const res = validateProductionConfig(valid);
  assert.equal(res.valid, true);
});

test("validateProductionConfig rejects localhost loopback OTEL endpoint", () => {
  const invalidEnabled = {
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
    MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
    EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
    SMTP_HOST: "smtp.resend.com",
    SMTP_FROM: "Matchday <no-reply@matchday.poladex.shop>",
    OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://127.0.0.1:4318",
  };

  assert.throws(() => validateProductionConfig(invalidEnabled), /cannot use local loopback/);

  const invalidDisabledWithLoopback = {
    ...invalidEnabled,
    OTEL_ENABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  };

  assert.throws(() => validateProductionConfig(invalidDisabledWithLoopback), /must not specify localhost loopback/);
});

const telemetryProduction = {
  OCI_PUBLIC_HOSTNAME: "matchday.example.com",
  APP_ENV: "production",
  NODE_ENV: "production",
  API_ALLOWED_ORIGINS: "https://matchday.example.com",
  MATCHDAY_PUBLIC_ORIGIN: "https://matchday.example.com",
  SCORING_SESSION_SEAL_KEY: "a".repeat(43),
  POSTGRES_DB: "matchday_prod",
  POSTGRES_USER: "matchday_prod",
  POSTGRES_PASSWORD: "synthetic-password",
  REDIS_PASSWORD: "synthetic-redis",
  DEEP_HEALTH_TOKEN: "b".repeat(32),
  IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
  IDENTITY_FLOW_SEAL_KEY: "d".repeat(43),
  SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "e".repeat(32),
  SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET: "f".repeat(32),
  MATCHDAY_CLIENT_IP_SECRET: "c".repeat(32),
  EDGE_CACHE_PURGE_BEARER_TOKEN: "g".repeat(32),
  SMTP_HOST: "smtp.example.com",
  SMTP_FROM: "noreply@example.com",
  OTEL_ENABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
  OTEL_COLLECTOR_EXTERNAL_ENDPOINT: "https://ingest.example.com",
};

const applicationHeaderKeys = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
];

for (const key of applicationHeaderKeys) {
  test(`production preflight rejects ${key} without exposing its value`, () => {
    const header = "authorization=synthetic-header-must-not-appear";
    for (const enabled of ["true", "false"]) {
      assert.throws(
        () => validateProductionConfig({ ...telemetryProduction, OTEL_ENABLED: enabled, [key]: header }),
        (error) => {
          assert.match(error.message, new RegExp(key));
          assert.match(error.message, /authentication belongs at the collector boundary/);
          assert.equal(error.message.includes(header), false);
          return true;
        },
      );
    }
  });
}

test("production preflight rejects all populated application header variables", () => {
  const headers = Object.fromEntries(applicationHeaderKeys.map((key) => [key, "authorization=synthetic-only"]));
  assert.throws(
    () => validateProductionConfig({ ...telemetryProduction, ...headers }),
    (error) => {
      for (const key of applicationHeaderKeys) assert.match(error.message, new RegExp(key));
      assert.equal(error.message.includes("authorization=synthetic-only"), false);
      return true;
    },
  );
});

test("production preflight accepts unset, empty and whitespace application headers", () => {
  for (const enabled of ["true", "false"]) {
    assert.equal(validateProductionConfig({ ...telemetryProduction, OTEL_ENABLED: enabled }).valid, true);
    for (const value of ["", " \t "]) {
      const headers = Object.fromEntries(applicationHeaderKeys.map((key) => [key, value]));
      assert.equal(validateProductionConfig({ ...telemetryProduction, OTEL_ENABLED: enabled, ...headers }).valid, true);
    }
  }
});

test("production preflight agrees with the actual enabled runtime on application headers", async () => {
  const previous = Object.fromEntries(applicationHeaderKeys.map((key) => [key, process.env[key]]));
  const config = {
    enabled: true,
    endpoint: telemetryProduction.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: "production",
    serviceName: "matchday-config-alignment-test",
    metricExportIntervalMs: 60_000,
  };
  const fakeExporter = () => ({
    export: (_data, callback) => callback({ code: 0 }),
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  });
  const exporters = { traceExporter: fakeExporter(), metricExporter: fakeExporter() };
  try {
    for (const key of applicationHeaderKeys) delete process.env[key];
    assert.equal(validateProductionConfig(telemetryProduction).valid, true);
    const runtime = await startTelemetryRuntime(config, exporters);
    await runtime.shutdown();
    for (const key of applicationHeaderKeys) {
      process.env[key] = "authorization=synthetic-alignment-only";
      assert.throws(
        () => validateProductionConfig({ ...telemetryProduction, [key]: process.env[key] }),
        /collector boundary/,
      );
      await assert.rejects(startTelemetryRuntime(config, exporters), /collector boundary/);
      delete process.env[key];
    }
  } finally {
    for (const key of applicationHeaderKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("internal collector is an exact named exception and outbound is always HTTPS", () => {
  assert.equal(validateProductionConfig(telemetryProduction).valid, true);
  for (const endpoint of [
    "http://otel-collector:4319",
    "http://otel-collector:4318/path",
    "http://otel-collector:4318/",
    "http://other:4318",
    "https://[::1]:4318",
    "https://127.0.0.2:4318",
    "https://localhost.:4318",
    "https://user:private@example.com",
    "https://example.com?token=private",
    "https://example.com#private",
    "bad-url",
  ]) {
    for (const enabled of ["true", "false"]) {
      assert.throws(() =>
        validateProductionConfig({
          ...telemetryProduction,
          OTEL_ENABLED: enabled,
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        }),
      );
    }
  }
  for (const endpoint of [
    "http://otel-collector:4318",
    "http://ingest.example.com",
    "https://localhost:4318",
    "https://[::1]:4318",
    "https://user:private@example.com",
    "https://example.com?token=private",
    "bad-url",
  ]) {
    assert.throws(() =>
      validateProductionConfig({ ...telemetryProduction, OTEL_COLLECTOR_EXTERNAL_ENDPOINT: endpoint }),
    );
  }
  assert.throws(
    () => validateProductionConfig({ ...telemetryProduction, OTEL_COLLECTOR_EXTERNAL_ENDPOINT: "" }),
    /OTEL_COLLECTOR_EXTERNAL_ENDPOINT is required/,
  );
  assert.throws(() => validateProductionConfig({ ...telemetryProduction, OTEL_ENABLED: "yes" }), /OTEL_ENABLED must/);
});

test("validateProductionConfig fails closed when EMAIL_BOUNCE_HANDLING_ENABLED=true without secret", () => {
  const invalid = {
    ...telemetryProduction,
    EMAIL_BOUNCE_HANDLING_ENABLED: "true",
  };
  assert.throws(
    () => validateProductionConfig(invalid),
    /EMAIL_PROVIDER_WEBHOOK_SECRET is required in production when EMAIL_BOUNCE_HANDLING_ENABLED is true/,
  );

  const placeholder = {
    ...telemetryProduction,
    EMAIL_BOUNCE_HANDLING_ENABLED: "true",
    EMAIL_PROVIDER_WEBHOOK_SECRET: "CHANGE_ME_WEBHOOK_SECRET",
  };
  assert.throws(
    () => validateProductionConfig(placeholder),
    /EMAIL_PROVIDER_WEBHOOK_SECRET contains unresolved placeholder CHANGE_ME/,
  );

  const valid = {
    ...telemetryProduction,
    EMAIL_BOUNCE_HANDLING_ENABLED: "true",
    EMAIL_PROVIDER_WEBHOOK_SECRET: "a".repeat(32),
  };
  assert.equal(validateProductionConfig(valid).valid, true);
});
