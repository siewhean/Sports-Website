#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseEnvContent(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export function validateProductionConfig(env) {
  const errors = [];

  const requiredFields = [
    "OCI_PUBLIC_HOSTNAME",
    "APP_ENV",
    "NODE_ENV",
    "API_ALLOWED_ORIGINS",
    "MATCHDAY_PUBLIC_ORIGIN",
    "SCORING_SESSION_SEAL_KEY",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "DEEP_HEALTH_TOKEN",
    "IDENTITY_CSRF_HMAC_SECRET",
    "IDENTITY_FLOW_SEAL_KEY",
    "SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET",
    "SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET",
    "MATCHDAY_CLIENT_IP_SECRET",
    "EDGE_CACHE_PURGE_BEARER_TOKEN",
    "SMTP_HOST",
    "SMTP_FROM",
  ];

  for (const field of requiredFields) {
    if (!env[field] || env[field].trim() === "") {
      errors.push(`Missing required production environment variable: ${field}`);
    }
  }

  // Reject CHANGE_ME
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string" && val.includes("CHANGE_ME")) {
      errors.push(`Variable ${key} contains unresolved placeholder CHANGE_ME`);
    }
  }

  // Reject staging hostnames in production
  if (env.APP_ENV === "production") {
    // "c5-drill" is the legacy drill-stack marker; OCI_STAGING_HOSTNAME is the configured staging host.
    const stagingMarkers = ["c5-drill", env.OCI_STAGING_HOSTNAME?.trim().toLowerCase()].filter(Boolean);
    for (const marker of stagingMarkers) {
      if (env.OCI_PUBLIC_HOSTNAME && env.OCI_PUBLIC_HOSTNAME.toLowerCase().includes(marker)) {
        errors.push(`Production OCI_PUBLIC_HOSTNAME must not point to staging hostname ${marker}`);
      }
      if (env.MATCHDAY_PUBLIC_ORIGIN && env.MATCHDAY_PUBLIC_ORIGIN.toLowerCase().includes(marker)) {
        errors.push(`Production MATCHDAY_PUBLIC_ORIGIN must not point to staging hostname ${marker}`);
      }
    }
    if (env.SMTP_HOST && (env.SMTP_HOST === "127.0.0.1" || env.SMTP_HOST === "localhost")) {
      errors.push("Production SMTP_HOST cannot use local loopback");
    }
    if (env.POSTGRES_DB === "matchday" || env.POSTGRES_USER === "matchday") {
      errors.push("Production POSTGRES_DB and POSTGRES_USER must be isolated from staging (got matchday)");
    }

    if (env.OTEL_ENABLED !== undefined && !["true", "false"].includes(env.OTEL_ENABLED)) {
      errors.push("OTEL_ENABLED must be true or false");
    }
    // Reject latent application credentials even while telemetry is disabled.
    for (const key of [
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    ]) {
      if (env[key]?.trim()) {
        errors.push(
          `Production application telemetry must not configure ${key}; authentication belongs at the collector boundary`,
        );
      }
    }
    const internalEndpoint = "http://otel-collector:4318";
    const validateEndpoint = (value, label, allowInternal) => {
      try {
        const url = new URL(value);
        const loopback =
          url.hostname === "localhost" ||
          url.hostname.endsWith(".localhost") ||
          url.hostname === "localhost." ||
          url.hostname.startsWith("127.") ||
          ["[::1]", "[::]", "0.0.0.0"].includes(url.hostname) ||
          url.hostname.startsWith("[::ffff:7f");
        if (loopback) {
          errors.push(
            env.OTEL_ENABLED === "false"
              ? `Production configuration must not specify localhost loopback ${label}`
              : `Production ${label} cannot use local loopback`,
          );
        }
        if (url.protocol !== "https:" && !(allowInternal && value === internalEndpoint)) {
          errors.push(
            `Production ${label} must use HTTPS${allowInternal ? " or the exact internal collector endpoint" : ""}`,
          );
        }
        if (url.username || url.password || url.search || url.hash) {
          errors.push(`Production ${label} must not include credentials, query, or fragment`);
        }
      } catch {
        errors.push(`Production ${label} must be a valid URL`);
      }
    };
    if (env.OTEL_ENABLED === "true" && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      errors.push("OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED is true");
    }
    if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      validateEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT, "OTEL_EXPORTER_OTLP_ENDPOINT", true);
    }
    if (env.OTEL_COLLECTOR_EXTERNAL_ENDPOINT) {
      validateEndpoint(env.OTEL_COLLECTOR_EXTERNAL_ENDPOINT, "OTEL_COLLECTOR_EXTERNAL_ENDPOINT", false);
    }
    if (
      env.OTEL_ENABLED === "true" &&
      env.OTEL_EXPORTER_OTLP_ENDPOINT === internalEndpoint &&
      !env.OTEL_COLLECTOR_EXTERNAL_ENDPOINT
    ) {
      errors.push("OTEL_COLLECTOR_EXTERNAL_ENDPOINT is required for enabled internal collector telemetry");
    }

    if (env.EMAIL_BOUNCE_HANDLING_ENABLED === "true") {
      if (!env.EMAIL_PROVIDER_WEBHOOK_SECRET || env.EMAIL_PROVIDER_WEBHOOK_SECRET.trim() === "") {
        errors.push(
          "EMAIL_PROVIDER_WEBHOOK_SECRET is required in production when EMAIL_BOUNCE_HANDLING_ENABLED is true",
        );
      } else if (env.EMAIL_PROVIDER_WEBHOOK_SECRET.includes("CHANGE_ME")) {
        errors.push("EMAIL_PROVIDER_WEBHOOK_SECRET contains unresolved placeholder CHANGE_ME");
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration validation failed:\n- ${errors.join("\n- ")}`);
  }

  return { valid: true, hostname: env.OCI_PUBLIC_HOSTNAME, app_env: env.APP_ENV };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const filePath = process.argv[2] ?? path.join(root, "infra/oci/.env.prod");
  readFile(filePath, "utf8")
    .then((content) => {
      const env = parseEnvContent(content);
      const res = validateProductionConfig(env);
      console.log(`✓ Production configuration valid: ${res.hostname} (${res.app_env})`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
