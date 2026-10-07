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

  writeFileSync(path.join(repository, ".gitignore"), ".env.prod\n.env.oci\nartifacts/\n");

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
  writeFileSync(path.join(repository, "infra/oci/.env.oci"), envContent, { mode: 0o600 });

  const activeSlotFile = path.join(directory, "active-slot.env");
  if (options.initialSlot) {
    writeFileSync(activeSlotFile, `ACTIVE_SLOT=${options.initialSlot}\n`);
  }

  const runtimeCaddyfile = path.join(directory, "runtime-Caddyfile");
  let templateCaddy = readFileSync(path.join(repository, "infra/oci/Caddyfile"), "utf8");
  if (options.initialSlot === "green") {
    templateCaddy = templateCaddy
      .replace("172.31.0.11:4000", "172.31.0.21:4000")
      .replace("trusted_proxies 172.31.0.12", "trusted_proxies 172.31.0.22")
      .replace("172.31.0.12:3000", "172.31.0.22:3000");
  }
  writeFileSync(runtimeCaddyfile, templateCaddy);

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
    } else if (args.some(a => a.includes("{{.State.Status}}"))) {
      if (process.env.MOCK_RESTORE_WORKER_FAILS === "1") {
        console.log("exited");
      } else {
        console.log("running");
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
  } else if (args.includes("up")) {
    if (process.env.MOCK_RESTORE_WORKER_UP_FAILS === "1" && args.includes("worker")) {
      process.exit(1);
    }
    process.exit(0);
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
    } else if (script.includes("x-matchday-build-id")) {
      if (process.env.MOCK_CANDIDATE_WEB_BUILD_MISMATCH === "1") {
        process.stdout.write("bad-web-build");
      } else {
        process.stdout.write(process.env.CANDIDATE_SHA);
      }
      process.exit(0);
    } else if (script.includes("127.0.0.1:3000")) {
      if (process.env.MOCK_CANDIDATE_WEB_READY_FAILS === "1") process.exit(1);
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
  } else if (args.some(a => a.includes("https://matchday.poladex.shop/"))) {
    if (process.env.MOCK_ROUTED_WEB_FAILS === "1") process.exit(28);
    if (args.includes("-D")) {
      if (process.env.MOCK_ROUTED_WEB_BUILD_MISMATCH === "1") {
        console.log("HTTP/2 200\\r\\nx-matchday-build-id: wrong-web-sha\\r\\n");
      } else {
        console.log("HTTP/2 200\\r\\nx-matchday-build-id: " + process.env.CANDIDATE_SHA + "\\r\\n");
      }
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
        MATCHDAY_RUNTIME_CADDYFILE_PATH: runtimeCaddyfile,
        MOCK_LOG: log,
        ...extraEnv,
      },
    });
  };

  const ret = { directory, repository, sha, git, activeSlotFile, runtimeCaddyfile, deployLockFile, run, log };
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
  assert.equal(receipt.active_slot_after, "green");

  // Check runtime Caddyfile points to green upstream (172.31.0.21 and 172.31.0.22)
  const caddyfile = readFileSync(f.runtimeCaddyfile, "utf8");
  assert.ok(caddyfile.includes("172.31.0.21:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.22"));
  assert.ok(caddyfile.includes("172.31.0.22:3000"));

  // Tracked repo Caddyfile is NEVER modified
  const trackedCaddy = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  assert.ok(trackedCaddy.includes("172.31.0.11:4000"));
});

test("2. Green-to-Blue successful rollout promotes traffic and updates active slot to blue", (t) => {
  const f = createFixture(t, { initialSlot: "green" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Promoted Slot:\s+blue/);

  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=blue/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "SUCCESS");
  assert.equal(receipt.candidate_slot, "blue");
  assert.equal(receipt.active_slot_after, "blue");

  const caddyfile = readFileSync(f.runtimeCaddyfile, "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.12"));
});

test("3. Candidate API readiness failure triggers rollback before promotion without modifying Caddy", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CANDIDATE_READY_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate API failed internal readiness probe/);

  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=blue/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
  assert.match(receipt.failure_reason, /readiness probe/);

  // Runtime Caddyfile was NEVER modified
  const caddyfile = readFileSync(f.runtimeCaddyfile, "utf8");
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
  assert.equal(receipt.active_slot_after, "blue");
});

test("5. Candidate Web readiness failure triggers rollback before promotion", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CANDIDATE_WEB_READY_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate Web failed internal readiness probe/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("6. Candidate Web build-ID mismatch triggers rollback before promotion", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CANDIDATE_WEB_BUILD_MISMATCH: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /does not match candidate/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("7. Traffic promotion failure (Caddy reload failure) triggers rollback and reverts runtime Caddy", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CADDY_RELOAD_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Caddy reload failed/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("8. Post-promotion routed API health failure reverts Caddy to active slot and cleans up candidate", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_ROUTED_READY_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Reverting Caddy routing to active slot blue/);

  // Runtime Caddyfile reverted back to blue
  const caddyfile = readFileSync(f.runtimeCaddyfile, "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));
  assert.ok(caddyfile.includes("trusted_proxies 172.31.0.12"));
  assert.ok(!caddyfile.includes("172.31.0.21:4000"));

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
  assert.match(receipt.failure_reason, /Public routed \/health\/ready probe failed/);
});

test("9. Post-promotion routed API SHA mismatch triggers rollback", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_ROUTED_SHA_MISMATCH: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Public routed API git_sha .* does not match/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("10. Post-promotion routed Web health failure triggers rollback", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_ROUTED_WEB_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Public routed Web \/ probe failed/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("11. Post-promotion routed Web build-ID mismatch triggers rollback", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_ROUTED_WEB_BUILD_MISMATCH: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Public routed Web build ID .* does not match/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
});

test("12. Candidate worker instability triggers rollback and restores active worker", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_WORKER_UNSTABLE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate worker failed stability check/);
  assert.match(result.stderr, /Restoring previous active worker \(worker\)/);

  // Runtime Caddyfile reverted back to blue
  const caddyfile = readFileSync(f.runtimeCaddyfile, "utf8");
  assert.ok(caddyfile.includes("172.31.0.11:4000"));

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.active_slot_after, "blue");
  assert.equal(receipt.worker_handover_started, true);
  assert.equal(receipt.rollback_result, "COMPLETED");
});

test("13. Restoring active worker failure is surfaced loudly during rollback", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_WORKER_UNSTABLE: "1", MOCK_RESTORE_WORKER_UP_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: Failed to restart previous active worker/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.rollback_result, "FAILED_WORKER_RESTORE");
});

test("14. Concurrent deployment attempt is blocked by exclusive deployment lock", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });

  const pyProcess = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, subprocess, os, sys
f = open('${f.deployLockFile}', 'w')
fcntl.flock(f, fcntl.LOCK_EX)
p = subprocess.run(['bash', 'infra/oci/deploy-prod.sh'], cwd='${f.repository}', capture_output=True, text=True, env=dict(
  os.environ,
  PATH='${f.repository}/../bin:' + os.environ['PATH'],
  CANDIDATE_SHA='${f.sha}',
  OCI_PUBLIC_HOSTNAME='matchday.poladex.shop',
  MATCHDAY_ACTIVE_SLOT_FILE='${f.activeSlotFile}',
  MATCHDAY_DEPLOY_LOCK_FILE='${f.deployLockFile}',
  MATCHDAY_RUNTIME_CADDYFILE_PATH='${f.runtimeCaddyfile}'
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

test("15. Missing persistent state file reconciles cleanly from unambiguous Caddy routing", (t) => {
  const f = createFixture(t);
  // Ensure activeSlotFile does not exist
  rmSync(f.activeSlotFile, { force: true });

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /State file missing; reconciling active slot from unambiguous Caddy routing: blue/);
  assert.match(result.stdout, /Promoted Slot:\s+green/);

  const state = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state, /ACTIVE_SLOT=green/);
});

test("16. Invalid persistent state file fails closed", (t) => {
  const f = createFixture(t);
  writeFileSync(f.activeSlotFile, "ACTIVE_SLOT=purple\n");

  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERROR: Invalid ACTIVE_SLOT in .* Must be 'blue' or 'green'/);
});

test("17. Persistent state and Caddy routing disagreement fails closed (AMBIGUOUS_ACTIVE_SLOT)", (t) => {
  const f = createFixture(t, { initialSlot: "green" });
  // Set runtime Caddyfile to blue while state says green
  let blueCaddy = readFileSync(path.join(f.repository, "infra/oci/Caddyfile"), "utf8");
  writeFileSync(f.runtimeCaddyfile, blueCaddy);

  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /AMBIGUOUS_ACTIVE_SLOT: Persistent state records 'green' but runtime Caddy routes to 'blue'/,
  );
});

test("18. Two consecutive deployments succeed (blue -> green -> blue)", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });

  // 1st deploy: blue -> green
  const res1 = f.run();
  assert.equal(res1.status, 0, res1.stderr);
  assert.match(res1.stdout, /Promoted Slot:\s+green/);
  const state1 = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state1, /ACTIVE_SLOT=green/);

  // 2nd deploy: create new commit and deploy green -> blue
  writeFileSync(path.join(f.repository, "test-marker.txt"), "deploy-2\n");
  f.git("add", "test-marker.txt");
  f.git(
    "-c",
    "user.name=OPS002 Test",
    "-c",
    "user.email=ops002-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "deploy-2",
  );
  f.sha = f.git("rev-parse", "HEAD");

  const res2 = f.run({ CANDIDATE_SHA: f.sha });
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stdout, /Promoted Slot:\s+blue/);
  const state2 = readFileSync(f.activeSlotFile, "utf8");
  assert.match(state2, /ACTIVE_SLOT=blue/);
});

test("19. Tracked Git checkout remains 100% clean across deployment and rollback", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });

  const resSuccess = f.run();
  assert.equal(resSuccess.status, 0);
  assert.equal(f.git("status", "--porcelain"), "");

  // Now run rollback
  const resRollback = f.run({ MOCK_ROUTED_READY_FAILS: "1" });
  assert.notEqual(resRollback.status, 0);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("20. Receipt write failure on success causes deployment failure", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_RECEIPT_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: Failed to write deployment receipt/);
});

test("21. Receipt write failure on rollback preserves primary deployment failure", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  const result = f.run({ MOCK_CANDIDATE_READY_FAILS: "1", MOCK_RECEIPT_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic rollback initiated/);
  assert.match(result.stderr, /Candidate API failed internal readiness probe/);
  assert.match(result.stderr, /WARNING: Failed to write rollback receipt/);
});

test("22. Rollback Caddy reload failure is surfaced loudly and deployment still exits nonzero", (t) => {
  const f = createFixture(t, { initialSlot: "blue" });
  // Pre-route failure triggers rollback, during which reload fails
  const result = f.run({ MOCK_ROUTED_READY_FAILS: "1", MOCK_CADDY_RELOAD_FAILS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: Caddy reload failed during rollback/);

  const receipt = JSON.parse(readFileSync(path.join(f.repository, "artifacts/deploy-receipt.json"), "utf8"));
  assert.equal(receipt.outcome, "ROLLBACK");
  assert.equal(receipt.rollback_result, "FAILED_CADDY_RELOAD");
});
