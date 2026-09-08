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
