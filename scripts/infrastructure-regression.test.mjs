import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvContent, validateProductionConfig } from "./validate-production-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1. Caddyfile rejects ambiguous reverse_proxy api:4000 upstream", async () => {
  const caddyfile = await readFile(path.join(root, "infra/oci/Caddyfile"), "utf8");

  // Must not have ambiguous unqualified api:4000
  assert.equal(
    caddyfile.includes("reverse_proxy api:4000"),
    false,
    "Caddyfile must not use ambiguous 'reverse_proxy api:4000'",
  );

  // Must have dedicated production and staging site blocks
  assert.equal(
    caddyfile.includes("matchday.poladex.shop {"),
    true,
    "Caddyfile must contain matchday.poladex.shop block",
  );
  assert.equal(
    caddyfile.includes("c5-drill.poladex.shop {"),
    true,
    "Caddyfile must contain c5-drill.poladex.shop block",
  );
});

test("2. Caddyfile routes production and staging to distinct isolated subnets", async () => {
  const caddyfile = await readFile(path.join(root, "infra/oci/Caddyfile"), "utf8");

  // Production block must target subnet 172.31.0.0/24
  const prodMatch = caddyfile.match(/matchday\.poladex\.shop\s*\{([\s\S]*?)\n\}/);
  assert.ok(prodMatch, "matchday.poladex.shop block must exist");
  assert.ok(
    prodMatch[1].includes("172.31.0.11:4000") || prodMatch[1].includes("prod-api:4000"),
    "Production API upstream must target production network (172.31.0.11 or prod-api)",
  );

  // Staging block must target subnet 172.30.0.0/24
  const stagingMatch = caddyfile.match(/c5-drill\.poladex\.shop\s*\{([\s\S]*?)\n\}/);
  assert.ok(stagingMatch, "c5-drill.poladex.shop block must exist");
  assert.ok(
    stagingMatch[1].includes("172.30.0.11:4000") || stagingMatch[1].includes("staging-api:4000"),
    "Staging API upstream must target staging network (172.30.0.11 or staging-api)",
  );

  // Ensure production and staging do not route to the same API
  const prodApi = prodMatch[1].match(/reverse_proxy\s+([^\s]+)/)?.[1];
  const stagingApi = stagingMatch[1].match(/reverse_proxy\s+([^\s]+)/)?.[1];
  assert.notEqual(prodApi, stagingApi, "Production and staging upstreams must be distinct");
});

test("3. compose.yaml explicitly attaches Caddy to both staging and production networks", async () => {
  const composeStaging = await readFile(path.join(root, "infra/oci/compose.yaml"), "utf8");

  // Caddy service must have networks for both backend and prod_backend
  const caddyBlock = composeStaging.match(/caddy:[\s\S]*?networks:([\s\S]*?)(volumes:|networks:|$)/);
  assert.ok(caddyBlock, "Caddy service networks must exist in compose.yaml");
  assert.ok(caddyBlock[1].includes("backend:"), "Caddy must attach to staging backend");
  assert.ok(caddyBlock[1].includes("prod_backend:"), "Caddy must attach to prod_backend");

  // External network prod_backend must be declared
  assert.ok(
    composeStaging.includes("name: matchday-prod_backend") && composeStaging.includes("external: true"),
    "prod_backend external network must be declared in compose.yaml",
  );
});

test("4. Production compose and configuration do not require localhost loopback OTEL", async () => {
  const composeProd = await readFile(path.join(root, "infra/oci/compose.prod.yaml"), "utf8");

  assert.equal(
    composeProd.includes("127.0.0.1:4318"),
    false,
    "compose.prod.yaml must not contain hardcoded localhost OTEL 127.0.0.1:4318",
  );
});

test("5. APP_ENV=production passes configuration validation cleanly without fake telemetry", async () => {
  const validProduction = {
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
    OTEL_ENABLED: "false",
  };

  const validated = validateProductionConfig(validProduction);
  assert.equal(validated.valid, true);
  assert.equal(validated.app_env, "production");
});

test("6. deploy-prod.sh enforces exact 40-character Git SHA and fail-closed checks", async () => {
  const deployScript = await readFile(path.join(root, "infra/oci/deploy-prod.sh"), "utf8");

  assert.ok(
    deployScript.includes("CANDIDATE_SHA must be a full 40-character SHA"),
    "deploy-prod.sh must validate 40-character SHA",
  );
  assert.ok(
    deployScript.includes("validate-production-config.mjs"),
    "deploy-prod.sh must run validate-production-config.mjs",
  );
  assert.ok(
    deployScript.includes("certify-gate-f-migrations.mjs"),
    "deploy-prod.sh must certify migrations before rollout",
  );
  assert.equal(
    deployScript.includes("caddy reload --config /etc/caddy/Caddyfile || true"),
    false,
    "deploy-prod.sh must not use '|| true' on Caddy reload",
  );
});

test("7. Dockerfile attaches OCI standard revision labels to runtime components", async () => {
  const dockerfile = await readFile(path.join(root, "infra/oci/Dockerfile"), "utf8");

  assert.ok(
    dockerfile.includes('LABEL org.opencontainers.image.revision="${MATCHDAY_BUILD_ID}"'),
    "Dockerfile must stamp org.opencontainers.image.revision",
  );
  assert.ok(
    dockerfile.includes('LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"'),
    "Dockerfile must stamp org.opencontainers.image.created",
  );
});

test("8. Production and staging databases are strictly isolated", async () => {
  const stagingEnvSample = await readFile(path.join(root, "infra/oci/.env.oci.example"), "utf8");
  const stagingEnv = parseEnvContent(stagingEnvSample);

  // Staging uses matchday
  assert.equal(stagingEnv.POSTGRES_DB ?? "matchday", "matchday");

  // Production must reject matchday and require matchday_prod
  assert.throws(
    () =>
      validateProductionConfig({
        OCI_PUBLIC_HOSTNAME: "matchday.poladex.shop",
        APP_ENV: "production",
        NODE_ENV: "production",
        API_ALLOWED_ORIGINS: "https://matchday.poladex.shop",
        MATCHDAY_PUBLIC_ORIGIN: "https://matchday.poladex.shop",
        SCORING_SESSION_SEAL_KEY: "a".repeat(43),
        POSTGRES_DB: "matchday", // collides with staging!
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
      }),
    /must be isolated from staging/,
  );
});

test("9. Production and staging networks allocate distinct subnets and service names", async () => {
  const composeStaging = await readFile(path.join(root, "infra/oci/compose.yaml"), "utf8");
  const composeProd = await readFile(path.join(root, "infra/oci/compose.prod.yaml"), "utf8");

  // Staging subnet
  assert.ok(composeStaging.includes("172.30.0.0/24"), "Staging network must use 172.30.0.0/24");

  // Production subnet
  assert.ok(composeProd.includes("172.31.0.0/24"), "Production network must use 172.31.0.0/24");
  assert.ok(
    composeProd.includes("name: matchday-prod_backend"),
    "Production network name must be matchday-prod_backend",
  );

  // Staging vs Production service names/aliases
  assert.ok(composeProd.includes("prod-api"), "Production API must have prod-api alias");
  assert.ok(composeStaging.includes("staging-api"), "Staging API must have staging-api alias");
});

test("10. Deployment scripts do not require manual network mutations", async () => {
  const deployScript = await readFile(path.join(root, "infra/oci/deploy-prod.sh"), "utf8");

  // deploy-prod.sh automatically creates the network and attaches Caddy if needed
  assert.ok(
    deployScript.includes("docker network inspect matchday-prod_backend") ||
      deployScript.includes("docker network create --subnet 172.31.0.0/24 matchday-prod_backend"),
    "deploy-prod.sh must ensure matchday-prod_backend network exists",
  );
  assert.ok(
    deployScript.includes("docker network connect matchday-prod_backend"),
    "deploy-prod.sh must automatically connect Caddy if not already connected",
  );
});
