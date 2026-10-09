import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAuthenticationAssurancePolicy } from "../packages/config/src/authentication-assurance.ts";
import { parseEnvContent } from "./validate-production-config.mjs";

// Guards against env templates drifting from the config schema (e.g. the old
// IDENTITY_ASSURANCE_POLICY=strict, which the API rejects at boot).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const templates = [".env.example", "infra/oci/.env.oci.example", "infra/oci/.env.prod.example"];

// Enumerated variables whose allowed values are z.enum([...]) schemas in packages/config.
const configSource = read("packages/config/src/index.ts");
function zodEnumValues(schemaName) {
  const match = configSource.match(new RegExp(`const ${schemaName} = z\\.enum\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `could not find z.enum ${schemaName} in packages/config/src/index.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const enumVariables = {
  APP_ENV: zodEnumValues("environmentSchema"),
  LOG_LEVEL: zodEnumValues("logLevelSchema"),
  IDENTITY_PROVIDER: zodEnumValues("identityProviderSchema"),
};

for (const template of templates) {
  test(`${template}: enumerated values are accepted by the config schema`, () => {
    const env = parseEnvContent(read(template));
    for (const [name, allowed] of Object.entries(enumVariables)) {
      if (env[name] === undefined || env[name] === "") continue;
      assert.ok(allowed.includes(env[name]), `${template}: ${name}=${env[name]} must be one of ${allowed.join("|")}`);
    }
    if (env.IDENTITY_ASSURANCE_POLICY !== undefined) {
      // Uses the same parser the API calls at boot; throws on unknown values.
      assert.doesNotThrow(
        () => parseAuthenticationAssurancePolicy(env.IDENTITY_ASSURANCE_POLICY, env.IDENTITY_ASSURANCE_MAX_AGE_SECONDS),
        `${template}: IDENTITY_ASSURANCE_POLICY=${env.IDENTITY_ASSURANCE_POLICY} is rejected by authentication-assurance`,
      );
    }
  });
}

test("production template requires MFA assurance, never off or an unknown value", () => {
  const env = parseEnvContent(read("infra/oci/.env.prod.example"));
  assert.equal(env.IDENTITY_ASSURANCE_POLICY, "mfa");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.APP_ENV, "production");
});

test("the assurance parser really rejects the old 'strict' value (guard sanity check)", () => {
  assert.throws(
    () => parseAuthenticationAssurancePolicy("strict", undefined),
    /Invalid authentication assurance policy/,
  );
});

test("production template defines every BACKUP_ variable the backup compose service reads", () => {
  const env = parseEnvContent(read("infra/oci/.env.prod.example"));
  const compose = read("infra/oci/compose.prod.yaml");
  const referenced = new Set([...compose.matchAll(/\$\{(BACKUP_[A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 0);
  for (const name of referenced) assert.ok(name in env, `.env.prod.example is missing ${name}`);
  assert.ok(env.BACKUP_ALLOW_PLAINTEXT === "0", "plaintext uploads must default to disabled");
  for (const name of [
    "BACKUP_RETAIN_DAILY",
    "BACKUP_RETAIN_WEEKLY",
    "BACKUP_RETAIN_PREMIGRATION",
    "BACKUP_MAX_TOTAL_BYTES",
  ]) {
    assert.match(env[name], /^[1-9][0-9]*$/, `${name} must be a positive integer`);
  }
  assert.match(env.BACKUP_S3_ENDPOINT, /^https:\/\/.+\.compat\.objectstorage\..+\.oraclecloud\.com$/);
  assert.match(env.BACKUP_AGE_RECIPIENT, /^age1/);
});
