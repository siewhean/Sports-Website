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

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function isPinnedCollectorImageReference(value) {
  return /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/u.test(
    value,
  );
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
    if (env.OCI_PUBLIC_HOSTNAME && env.OCI_PUBLIC_HOSTNAME.includes("c5-drill")) {
      errors.push("Production OCI_PUBLIC_HOSTNAME must not point to staging hostname c5-drill");
    }
    if (env.MATCHDAY_PUBLIC_ORIGIN && env.MATCHDAY_PUBLIC_ORIGIN.includes("c5-drill")) {
      errors.push("Production MATCHDAY_PUBLIC_ORIGIN must not point to staging hostname c5-drill");
    }
    if (env.SMTP_HOST && (env.SMTP_HOST === "127.0.0.1" || env.SMTP_HOST === "localhost")) {
      errors.push("Production SMTP_HOST cannot use local loopback");
    }
    if (env.POSTGRES_DB === "matchday" || env.POSTGRES_USER === "matchday") {
      errors.push("Production POSTGRES_DB and POSTGRES_USER must be isolated from staging (got matchday)");
    }

    // Production telemetry is collector-only. Application containers send
    // unauthenticated OTLP on the isolated Docker bridge; only the collector
    // receives the provider token and exports over HTTPS.
    const otelEnabled = env.OTEL_ENABLED === "true";
    if (otelEnabled) {
      if (env.OTEL_EXPORTER_OTLP_ENDPOINT !== "http://otel-collector:4318") {
        errors.push(
          "Production OTEL_EXPORTER_OTLP_ENDPOINT must be exactly http://otel-collector:4318 when telemetry is enabled",
        );
      }

      if (!env.OTEL_COLLECTOR_IMAGE || env.OTEL_COLLECTOR_IMAGE.trim() === "") {
        errors.push("OTEL_COLLECTOR_IMAGE is required when OTEL_ENABLED is true");
      } else if (!isPinnedCollectorImageReference(env.OTEL_COLLECTOR_IMAGE)) {
        errors.push("OTEL_COLLECTOR_IMAGE must be a valid full image reference pinned by a sha256 digest");
      }

      if (!env.OTEL_BETTER_STACK_ENDPOINT || env.OTEL_BETTER_STACK_ENDPOINT.trim() === "") {
        errors.push("OTEL_BETTER_STACK_ENDPOINT is required when OTEL_ENABLED is true");
      } else {
        try {
          const exporterUrl = new URL(env.OTEL_BETTER_STACK_ENDPOINT);
          if (
            exporterUrl.protocol !== "https:" ||
            exporterUrl.username ||
            exporterUrl.password ||
            exporterUrl.search ||
            exporterUrl.hash ||
            exporterUrl.pathname !== "/"
          ) {
            errors.push(
              "OTEL_BETTER_STACK_ENDPOINT must be one HTTPS origin without credentials, path, query, or fragment",
            );
          }
          if (isLoopbackHostname(exporterUrl.hostname)) {
            errors.push("OTEL_BETTER_STACK_ENDPOINT must not use local loopback");
          }
        } catch {
          errors.push("OTEL_BETTER_STACK_ENDPOINT must be a valid HTTPS URL");
        }
      }

      if (!env.OTEL_BETTER_STACK_TOKEN_FILE || env.OTEL_BETTER_STACK_TOKEN_FILE.trim() === "") {
        errors.push("OTEL_BETTER_STACK_TOKEN_FILE is required when OTEL_ENABLED is true");
      } else if (
        !env.OTEL_BETTER_STACK_TOKEN_FILE.startsWith("/opt/matchday/secrets/") ||
        env.OTEL_BETTER_STACK_TOKEN_FILE.includes("..")
      ) {
        errors.push("OTEL_BETTER_STACK_TOKEN_FILE must be an absolute path under /opt/matchday/secrets/");
      }
    } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      try {
        const otelUrl = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT);
        if (isLoopbackHostname(otelUrl.hostname)) {
          errors.push("Production configuration must not specify localhost loopback OTEL_EXPORTER_OTLP_ENDPOINT");
        }
      } catch {
        errors.push("Production OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL if present");
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
