import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvContent, validateProductionConfig } from "./validate-production-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertTokenMountDoesNotCreateHostPath(composeSource, token) {
  // compose-go v2 encodes this bool with json:",omitempty", so explicit false
  // can disappear from rendered JSON. Require it in the exact source mount,
  // then reject any rendered true value instead of relying on serialization.
  assert.match(
    composeSource,
    /source: \/etc\/matchday\/secrets\/otel-bearer-token\n\s+target: \/run\/secrets\/otel-bearer-token\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false(?:\n|$)/,
    "Collector token mount must explicitly disable host-path creation in source",
  );
  assert.equal(token.bind.create_host_path ?? false, false);
}

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

test("11. Caddyfile and environment enforce explicit trusted proxy chain for Web BFF and Caddy ingress", async () => {
  const caddyfile = await readFile(path.join(root, "infra/oci/Caddyfile"), "utf8");
  const prodEnvSample = await readFile(path.join(root, "infra/oci/.env.prod.example"), "utf8");
  const stagingEnvSample = await readFile(path.join(root, "infra/oci/.env.oci.example"), "utf8");
  const prodEnv = parseEnvContent(prodEnvSample);
  const stagingEnv = parseEnvContent(stagingEnvSample);

  // Production Caddy block: API reverse proxy must trust production Web service only
  const prodMatch = caddyfile.match(/matchday\.poladex\.shop\s*\{([\s\S]*?)\n\}/);
  assert.ok(prodMatch, "matchday.poladex.shop block must exist");
  assert.ok(
    prodMatch[1].includes("trusted_proxies 172.31.0.12"),
    "Production @api reverse_proxy must specify 'trusted_proxies 172.31.0.12'",
  );

  // Staging Caddy block: API reverse proxy must trust staging Web service only
  const stagingMatch = caddyfile.match(/c5-drill\.poladex\.shop\s*\{([\s\S]*?)\n\}/);
  assert.ok(stagingMatch, "c5-drill.poladex.shop block must exist");
  assert.ok(
    stagingMatch[1].includes("trusted_proxies 172.30.0.12"),
    "Staging @api reverse_proxy must specify 'trusted_proxies 172.30.0.12'",
  );

  // Web blocks must not trust downstream proxies (browser X-Forwarded-For must be stripped by Caddy ingress)
  const webBlocks = caddyfile.match(/handle\s*\{[\s\S]*?reverse_proxy\s+172\.\d+\.0\.12:3000[\s\S]*?\}/g);
  assert.ok(webBlocks && webBlocks.length >= 2, "Web reverse_proxy blocks must exist");
  for (const block of webBlocks) {
    assert.equal(
      block.includes("trusted_proxies"),
      false,
      "Web reverse_proxy blocks must NOT have trusted_proxies (ingress Caddy must strip client XFF)",
    );
  }

  // API_TRUSTED_PROXIES in production must trust Caddy (172.31.0.10) and Web (172.31.0.12)
  assert.equal(
    prodEnv.API_TRUSTED_PROXIES,
    "172.31.0.10,172.31.0.12",
    "Production API_TRUSTED_PROXIES must configure both Caddy and Web IPs",
  );

  // API_TRUSTED_PROXIES in staging must trust Caddy (172.30.0.10) and Web (172.30.0.12)
  assert.equal(
    stagingEnv.API_TRUSTED_PROXIES,
    "172.30.0.10,172.30.0.12",
    "Staging API_TRUSTED_PROXIES must configure both Caddy and Web IPs",
  );
});

test("12. Collector production topology renders with the explicit env-file and isolates credentials", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "matchday-g3-compose-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(path.join(temporary, "infra/oci"), { recursive: true });
  await copyFile(path.join(root, "infra/oci/compose.prod.yaml"), path.join(temporary, "infra/oci/compose.prod.yaml"));
  await copyFile(
    path.join(root, "infra/oci/otel-collector.yaml"),
    path.join(temporary, "infra/oci/otel-collector.yaml"),
  );
  const sample = await readFile(path.join(root, "infra/oci/.env.prod.example"), "utf8");
  const synthetic =
    sample.replaceAll(/CHANGE_ME[A-Z0-9_]*/g, "synthetic-fixture-only") +
    "\nCANDIDATE_SHA=" +
    "a".repeat(40) +
    "\nBUILD_TIMESTAMP=2026-10-05T00:00:00.000Z\n";
  await writeFile(path.join(temporary, "infra/oci/.env.prod"), synthetic, { mode: 0o600 });
  const render = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/oci/.env.prod",
      "-f",
      "infra/oci/compose.prod.yaml",
      "--profile",
      "observability",
      "--profile",
      "migration",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: temporary,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  assert.equal(render.status, 0, render.stderr);
  const disabled = spawnSync(
    "docker",
    ["compose", "--env-file", "infra/oci/.env.prod", "-f", "infra/oci/compose.prod.yaml", "config", "--format", "json"],
    {
      cwd: temporary,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).services["otel-collector"], undefined);
  const rendered = JSON.parse(render.stdout);
  const collector = rendered.services["otel-collector"];
  assert.deepEqual(Object.keys(collector.networks), ["backend"]);
  assert.equal(collector.networks.backend.ipv4_address, "172.31.0.14");
  assert.equal(rendered.networks.backend.name, "matchday-prod_backend");
  assert.equal(collector.ports, undefined);
  assert.equal(collector.network_mode, undefined);
  assert.match(collector.image, /^otel\/opentelemetry-collector-contrib:0\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
  assert.equal(collector.user, "0:0");
  assert.equal(collector.read_only, true);
  assert.deepEqual(collector.cap_drop, ["ALL"]);
  assert.equal(Number(collector.mem_limit), 256 * 1024 * 1024);
  const token = collector.volumes.find((volume) => volume.target === "/run/secrets/otel-bearer-token");
  assert.equal(token.source, "/etc/matchday/secrets/otel-bearer-token");
  assert.equal(token.read_only, true);
  const composeSource = await readFile(path.join(root, "infra/oci/compose.prod.yaml"), "utf8");
  assertTokenMountDoesNotCreateHostPath(composeSource, token);
  for (const name of ["api", "worker", "web", "migrate"]) {
    assert.equal(rendered.services[name].volumes?.some((volume) => volume.target === token.target) ?? false, false);
    for (const key of Object.keys(rendered.services[name].environment)) {
      assert.equal(/BETTER_STACK|OTEL.*TOKEN|OTEL.*HEADERS/i.test(key), false);
    }
  }
  const configuration = await readFile(path.join(root, "infra/oci/otel-collector.yaml"), "utf8");
  assert.match(configuration, /filename: \/run\/secrets\/otel-bearer-token/);
  assert.match(configuration, /authenticator: bearertokenauth\/provider/);
  assert.match(configuration, /insecure: false/);
  assert.match(configuration, /insecure_skip_verify: false/);
  assert.match(configuration, /endpoint: 0.0.0.0:13133/);
  assert.match(configuration, /processors: \[memory_limiter, resource\/production, batch\]/);
  assert.equal(/Authorization:|Bearer [A-Za-z0-9]|token:\s*[^#\n]|debug:|logging:/.test(configuration), false);
  const deployment = await readFile(path.join(root, "infra/oci/deploy-prod.sh"), "utf8");
  for (const line of deployment
    .split("\n")
    .filter((line) => line.includes("docker compose") && line.includes("compose.prod.yaml"))) {
    assert.match(line, /docker compose --env-file infra\/oci\/\.env\.prod/);
  }
});

test("13. Collector token mount rejects host-path creation even when Compose omits false", async () => {
  const source = await readFile(path.join(root, "infra/oci/compose.prod.yaml"), "utf8");
  assertTokenMountDoesNotCreateHostPath(source, { bind: {} });
  assertTokenMountDoesNotCreateHostPath(source, { bind: { create_host_path: false } });
  assert.throws(() => assertTokenMountDoesNotCreateHostPath(source, { bind: { create_host_path: true } }));
  const unsafeSource = source.replace("create_host_path: false", "create_host_path: true");
  assert.notEqual(unsafeSource, source);
  assert.throws(() => assertTokenMountDoesNotCreateHostPath(unsafeSource, { bind: {} }), /must explicitly disable/);
  assert.throws(
    () =>
      assertTokenMountDoesNotCreateHostPath(source.replace("          create_host_path: false\n", ""), { bind: {} }),
    /must explicitly disable/,
  );
});


test("14. Production worker stop grace exceeds its absolute shutdown deadline", async () => {
  const compose = await readFile(path.join(root, "infra/oci/compose.prod.yaml"), "utf8");
  const shutdownSource = await readFile(path.join(root, "apps/worker/src/telemetry.ts"), "utf8");
  const worker = compose.match(/\n  worker:\n([\s\S]*?)(?=\nvolumes:)/);
  assert.ok(worker, "Production worker service must exist");
  const grace = worker[1].match(/stop_grace_period:\s*(\d+)s/);
  assert.ok(grace, "Production worker must declare an explicit stop_grace_period");
  const deadline = shutdownSource.match(/WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS\s*=\s*([\d_]+)/);
  assert.ok(deadline, "Worker must declare an absolute whole-process shutdown deadline");
  const deadlineMs = Number(deadline[1].replaceAll("_", ""));
  const graceMs = Number(grace[1]) * 1_000;
  assert.ok(graceMs > deadlineMs, "Container stop grace must exceed the worker process deadline");
});
