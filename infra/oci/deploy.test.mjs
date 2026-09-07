import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(new URL("./deploy.sh", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, { environment = "", mismatch = false, readinessFails = false, workerRestarts = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "matchday-oci-deploy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const bin = path.join(directory, "bin");
  mkdirSync(path.join(repository, "infra/oci"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(deployScript, path.join(repository, "infra/oci/deploy.sh"));
  writeFileSync(path.join(repository, ".gitignore"), ".env.oci\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=OCI Test", "-c", "user.email=oci-test@example.invalid", "commit", "--quiet", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(path.join(repository, "infra/oci/.env.oci"), environment || "APP_ENV=staging\n", { mode: 0o600 });
  const mock = path.join(directory, "mock.mjs");
  const log = path.join(directory, "calls.jsonl");
  writeFileSync(
    mock,
    `import { appendFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify({ tool, args, sha: process.env.CANDIDATE_SHA }) + "\\n");
if (tool === "docker" && args.includes("config")) {
  const origin = "https://" + process.env.OCI_PUBLIC_HOSTNAME;
  const origins = process.env.MOCK_MISMATCH === "1" ? origin + ".attacker.invalid" : origin;
  console.log([
    "API_ALLOWED_ORIGINS: " + origins,
    "MATCHDAY_PUBLIC_ORIGIN: " + origin,
    "IDENTITY_OIDC_CALLBACK_URI: " + origin + "/api/v1/identity/callback",
    "IDENTITY_POST_AUTH_REDIRECT_URIS: " + origin + "/organiser",
  ].map(line => "      " + line).join("\\n"));
} else if (tool === "docker" && args.includes("inspect")) {
  console.log(process.env.MOCK_WORKER_RESTARTS === "1" ? "running 1" : "running 0");
} else if (tool === "docker" && args.includes("ps") && args.includes("-q")) {
  console.log("worker-id");
} else if (tool === "docker" && args.includes("exec")) {
  process.stdout.write(process.env.CANDIDATE_SHA);
} else if (tool === "curl") {
  if (args.some(arg => arg.endsWith("/health/ready"))) {
    if (process.env.MOCK_READINESS_FAILS === "1") process.exit(28);
    console.log("{}");
  } else {
    console.log("HTTP/2 200\\nx-matchday-build-id: " + process.env.CANDIDATE_SHA + "\\n");
  }
}
`,
  );
  for (const tool of ["docker", "curl", "sleep"]) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} ${tool} "$@"\n`, {
      mode: 0o755,
    });
  }
  const result = spawnSync("bash", ["infra/oci/deploy.sh"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CANDIDATE_SHA: sha,
      OCI_PUBLIC_HOSTNAME: "staging.example.com",
      MOCK_LOG: log,
      MOCK_MISMATCH: mismatch ? "1" : "0",
      MOCK_READINESS_FAILS: readinessFails ? "1" : "0",
      MOCK_WORKER_RESTARTS: workerRestarts ? "1" : "0",
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...result, calls, sha };
}

test("placeholder guidance in comments does not block deployment", (t) => {
  const result = fixture(t, { environment: "  # Replace CHANGE_ME values before deploying\nAPP_ENV=staging\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OCI deployment ready/);
  assert.ok(result.calls.some((call) => call.args.includes("build")));
});

test("real placeholders fail before Docker without printing the secret", (t) => {
  const secret = "private-prefix-CHANGE_ME-private-suffix";
  const result = fixture(t, { environment: `POSTGRES_PASSWORD=${secret}\n` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Replace every CHANGE_ME placeholder/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  assert.equal(result.calls.length, 0);
});

test("the exported candidate overrides a previous deployment SHA in the environment file", (t) => {
  const result = fixture(t, { environment: `CANDIDATE_SHA=${"0".repeat(40)}\nAPP_ENV=staging\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.length > 0);
  assert.ok(result.calls.every((call) => call.sha === result.sha));
});

test("a configured origin with a matching prefix but different hostname is rejected before build", (t) => {
  const result = fixture(t, { mismatch: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconsistent with OCI_PUBLIC_HOSTNAME/);
  assert.ok(!result.calls.some((call) => call.args.includes("build")));
});

test("readiness failures stop after bounded attempts and each request has timeouts", (t) => {
  const result = fixture(t, { readinessFails: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not become ready/);
  const requests = result.calls.filter((call) => call.tool === "curl");
  assert.equal(requests.length, 60);
  assert.ok(requests.every((call) => call.args.includes("--connect-timeout") && call.args.includes("--max-time")));
  assert.equal(result.calls.filter((call) => call.tool === "sleep").length, 59);
  assert.ok(!result.stdout.includes("OCI deployment ready"));
});

test("a worker that restarted is rejected even when API and web are ready", (t) => {
  const result = fixture(t, { workerRestarts: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worker failed startup stability check/);
  assert.ok(!result.stdout.includes("OCI deployment ready"));
});
