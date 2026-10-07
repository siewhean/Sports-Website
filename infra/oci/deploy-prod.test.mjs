import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployScriptPath = path.join(root, "infra/oci/deploy-prod.sh");
const caddyfilePath = path.join(root, "infra/oci/Caddyfile");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function createFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "matchday-ops002-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const repository = path.join(directory, "repository");
  const bin = path.join(directory, "bin");
  mkdirSync(path.join(repository, "infra/oci"), { recursive: true });
  mkdirSync(path.join(repository, "scripts"), { recursive: true });
  mkdirSync(bin);

  copyFileSync(deployScriptPath, path.join(repository, "infra/oci/deploy-prod.sh"));
  copyFileSync(caddyfilePath, path.join(repository, "infra/oci/Caddyfile"));

  // Mock scripts/validate-production-config.mjs and scripts/certify-gate-f-migrations.mjs
  writeFileSync(
    path.join(repository, "scripts/validate-production-config.mjs"),
    "console.log('✓ Production configuration valid'); process.exit(0);\n",
  );
  writeFileSync(
    path.join(repository, "scripts/certify-gate-f-migrations.mjs"),
    "console.log('✓ Migrations certified'); process.exit(0);\n",
  );

  writeFileSync(path.join(repository, ".gitignore"), ".env.prod\n");

  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=OPS002 Test",
    "-c",
    "user.email=ops002-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");

  // .env.prod fixture
  const envContent = options.environment || `OCI_PUBLIC_HOSTNAME=matchday.poladex.shop\nAPP_ENV=production\n`;
  writeFileSync(path.join(repository, "infra/oci/.env.prod"), envContent, { mode: 0o600 });

  const activeSlotFile = path.join(directory, "active-slot.env");
  if (options.initialSlot) {
    writeFileSync(activeSlotFile, `ACTIVE_SLOT=${options.initialSlot}\n`);
  }

  const deployLockFile = path.join(directory, "deploy.lock");
  const log = path.join(directory, "mock-calls.jsonl");

  const mock = path.join(directory, "mock.mjs");
  writeFileSync(
    mock,
    `import { appendFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify({ tool, args }) + "\\n");

if (tool === "docker") {
  if (args.includes("network") && args.includes("inspect")) {
    process.exit(0);
  } else if (args.includes("inspect")) {
    if (args.some(a => a.includes("{{.State.Status}} {{.RestartCount}}"))) {
      if (process.env.MOCK_WORKER_UNSTABLE === "1") {
        console.log("running 1");
      } else {
        console.log("running 0");
      }
      process.exit(0);
    } else if (args.some(a => a.includes("Config.Env"))) {
      console.log("GIT_SHA=" + process.env.CANDIDATE_SHA);
      process.exit(0);
    } else if (args.some(a => a.includes("revision"))) {
      console.log(process.env.MOCK_LABEL_MISMATCH === "1" ? "wrong-sha" : process.env.CANDIDATE_SHA);
      process.exit(0);
    } else if (args.some(a => a.includes("{{.Image}}"))) {
      console.log("sha256:mockimage123");
      process.exit(0);
    }
    console.log("{}");
  } else if (args.includes("ps") && args.includes("-q")) {
    console.log("mock-container-id-123");
  } else if (args.includes("exec")) {
    if (args.includes("caddy") && args.includes("reload")) {
      if (process.env.MOCK_CADDY_RELOAD_FAILS === "1") process.exit(1);
      process.exit(0);
    }
    // node -e ...
    const script = args[args.length - 1];
    if (script.includes("health/ready")) {
      if (process.env.MOCK_CANDIDATE_READY_FAILS === "1") process.exit(1);
      process.exit(0);
    } else if (script.includes("health/live")) {
      if (process.env.MOCK_CANDIDATE_LIVE_FAILS === "1") process.exit(1);
      process.exit(0);
    } else if (script.includes("environment")) {
      process.stdout.write("production");
      process.exit(0);
    } else if (script.includes("git_sha")) {
      process.stdout.write(process.env.MOCK_API_SHA_MISMATCH === "1" ? "bad-sha" : process.env.CANDIDATE_SHA);
      process.exit(0);
    }
    process.exit(0);
  }
  process.exit(0);
} else if (tool === "curl") {
  if (args.some(a => a.includes("/health/ready"))) {
    if (process.env.MOCK_ROUTED_READY_FAILS === "1") process.exit(28);
    console.log("OK");
    process.exit(0);
  } else if (args.some(a => a.includes("/api/v1/meta/build"))) {
    if (process.env.MOCK_ROUTED_SHA_MISMATCH === "1") {
      console.log(JSON.stringify({ git_sha: "mismatch-sha" }));
    } else {
      console.log(JSON.stringify({ git_sha: process.env.CANDIDATE_SHA }));
    }
    process.exit(0);
  }
  process.exit(0);
}
`,
  );

  for (const tool of ["docker", "curl", "sleep"]) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} ${tool} "$@"\n`, {
      mode: 0o755,
    });
  }

  const run = (extraEnv = {}) => {
    return spawnSync("bash", ["infra/oci/deploy-prod.sh"], {
      cwd: repository,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANDIDATE_SHA: ret.sha,
        OCI_PUBLIC_HOSTNAME: "matchday.poladex.shop",
        MATCHDAY_ACTIVE_SLOT_FILE: activeSlotFile,
        MATCHDAY_DEPLOY_LOCK_FILE: deployLockFile,
        MATCHDAY_CADDYFILE_PATH: path.join(repository, "infra/oci/Caddyfile"),
        MOCK_LOG: log,
        ...extraEnv,
      },
    });
  };

  const ret = { directory, repository, sha, git, activeSlotFile, deployLockFile, run, log };
  return ret;
}

test("1. Blue-to-Green successful rollout promotes traffic and updates active slot to green", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Promoted Slot:\s+green/);
  assert.match(result.stdout, /PRODUCTION DEPLOYMENT SUCCESSFUL/);

  // Check state file updated to green
  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=green/);
  assert.match(state, new RegExp(`ACTIVE_SHA=${f.sha}`));

  // Check receipt file
  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "SUCCESS");
  assert.equal(receipt.active_slot_before, "blue");
  assert.equal(receipt.candidate_slot, "green");

  // Check Caddyfile points to green upstream (172.31.0.21 and 172.31.0.22)
  const caddyfile = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  assert.ok(caddyfile.includes("172.31.0.21:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.22"));
  assert.ok(caddyfile.includes("172.31.0.22:3000"));
});

test("2. Green-to-Blue successful rollout promotes traffic and updates active slot to blue", (t) => {
  const f = createFixture(t, { initialSlot: "green" });
  // Set Caddyfile to green initially
  const caddyfilePath = path.join(f.repository, "infra/oci/Caddyfile");
  const initCaddy = readFileSync(caddyfilePath, "utf8")
    .replace("172.31.0.11:4000", "172.31.0.21:4000")
    .replace("trusted_proxies 172.31.0.12", "trusted_proxies 172.31.0.22")
    .replace("172.31.0.12:3000", "172.31.0.22:3000");
  writeFileSync(caddyfilePath, initCaddy);
  // Commit changed Caddyfile so working copy is clean for CANDIDATE_SHA
  f.git("add", "infra/oci/Caddyfile");
  f.git(
    "-c",
    "user.name=OPS002 Test",
    "-c",
    "user.email=ops002-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "init-green",
  );
  f.sha = f.git("rev-parse", "HEAD");

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Promoted Slot:\s+blue/);

  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=blue/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "SUCCESS");
  assert.equal(receipt.candidate_slot, "blue");

  const caddyfile = readFileSync(caddyfilePath, "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.12"));
});

test("3. Candidate API readiness failure triggers rollback before promotion without modifying Caddy", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CANDIDATE_READY_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate API failed internal readiness probe/);

  // Active slot remains blue
  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=blue/);

  // Receipt logs rollback
  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.match(receipt.failure_reason, /readiness probe/);

  // Caddyfile was NEVER modified
  const caddyfile = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));
  assert.ok(!caddyfile.includes("172.31.0.21:4000"));
});

test("4. Candidate API SHA mismatch triggers rollback before promotion", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_API_SHA_MISMATCH: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /does not match candidate/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
});

test("5. Post-promotion routed health check failure reverts Caddy to active slot and cleans up candidate", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_ROUTED_READY_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Reverting Caddy routing to active slot blue/);

  // Caddyfile reverted back to blue
  const caddyfile = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.12"));
  assert.ok(!caddyfile.includes("172.31.0.21:4000"));

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.match(receipt.failure_reason, /Public routed \/health\/ready probe failed/);
});

test("6. Worker instability failure triggers rollback and restores active slot", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_WORKER_UNSTABLE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate worker failed stability check/);

  // Caddyfile reverted back to blue
  const caddyfile = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
});

test("7. Concurrent deployment attempt is blocked by exclusive deployment lock", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });

  // Hold flock on lock file from another process
  const blocker = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, time, sys
f = open('${f.deployLockFile}', 'w')
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
print('LOCKED')
sys.stdout.flush()
time.sleep(2)
`,
    ],
    { timeout: 5000 },
  );

  // Now verify deploy-prod.sh fails cleanly if run when lock is held
  // We simulate lock held by running python background script
  const pyProcess = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, subprocess, os, sys
f = open('${f.deployLockFile}', 'w')
fcntl.flock(f, fcntl.LOCK_EX)
# Now invoke deploy-prod.sh
p = subprocess.run(['bash', 'infra/oci/deploy-prod.sh'], cwd='${f.repository}', capture_output=True, text=True, env=dict(
  os.environ,
  PATH='${f.repository}/../bin:' + os.environ['PATH'],
  CANDIDATE_SHA='${f.sha}',
  OCI_PUBLIC_HOSTNAME='matchday.poladex.shop',
  MATCHDAY_ACTIVE_SLOT_FILE='${f.activeSlotFile}',
  MATCHDAY_DEPLOY_LOCK_FILE='${f.deployLockFile}',
  MATCHDAY_CADDYFILE_PATH='${f.repository}/infra/oci/Caddyfile'
))
print('STATUS=' + str(p.returncode))
print('STDERR=' + p.stderr)
sys.stdout.flush()
`,
    ],
    { encoding: "utf8" },
  );

  assert.match(pyProcess.stdout, /STATUS=1/);
  assert.match(pyProcess.stdout, /Another deployment is already in progress/);
});
