import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateDeploymentFreeze,
  timingSafeEqualStrings,
  parseEnvContent,
  writeFreezeReceipt,
  VALID_COMPETITION_STATUSES,
  ACTIVE_COMPETITION_STATUSES,
} from "./deployment-freeze-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const policyScriptPath = path.join(root, "infra/oci/deployment-freeze-policy.mjs");

function createMockProvider(snapshotData) {
  return {
    async getSnapshot() {
      if (typeof snapshotData === "function") {
        return snapshotData();
      }
      return snapshotData;
    },
  };
}

test("1. NO_ACTIVE_COMPETITION allows deployment when no competitions are active", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [],
    scoringMatches: [],
    competitions: [
      { id: "comp-1", name: "Completed League 2025", status: "completed" },
      { id: "comp-2", name: "Draft Winter Series", status: "draft" },
      { id: "comp-3", name: "Published Upcoming Cup", status: "published" },
    ],
  });

  const result = await evaluateDeploymentFreeze({}, provider);
  assert.equal(result.disposition, "ALLOW");
  assert.equal(result.status, "ALLOW");
  assert.equal(result.code, "NO_ACTIVE_COMPETITION");
  assert.equal(result.allowed, true);
  assert.equal(result.overrideApplied, false);
});

test("2. ACTIVE_COMPETITION blocks deployment when exactly 1 active or live competition is present", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-singapore-open", name: "Singapore Canoe Polo Open 2026", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-singapore-open", name: "Singapore Canoe Polo Open 2026", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze({}, provider);
  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.code, "ACTIVE_COMPETITION");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Active competition currently in progress/);
});

test("3. MULTIPLE_ACTIVE_COMPETITIONS blocks deployment when 2 or more competitions are active", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [
      { id: "comp-1", name: "Tournament 1", status: "active" },
      { id: "comp-2", name: "Tournament 2", status: "live" },
    ],
    scoringMatches: [],
  });

  const result = await evaluateDeploymentFreeze({}, provider);
  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.code, "MULTIPLE_ACTIVE_COMPETITIONS");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Multiple active competitions currently in progress \(2 active competitions\)/);
});

test("4. SCORING_IN_PROGRESS blocks deployment when match state is in_progress", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Canoe Polo National Championship", status: "live" }],
    scoringMatches: [{ id: "match-101", competition_id: "comp-1", state: "in_progress" }],
  });

  const result = await evaluateDeploymentFreeze({}, provider);
  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.code, "SCORING_IN_PROGRESS");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Live match scoring is currently in progress/);
});

test("5. STALE_FREEZE_INFORMATION blocks deployment fail-closed on old or invalid timestamps", async () => {
  // 5a. Stale timestamp (older than maxAgeMs)
  const staleTime = new Date(Date.now() - 120_000).toISOString();
  const staleProvider = createMockProvider({
    timestamp: staleTime,
    activeCompetitions: [],
    scoringMatches: [],
  });

  const resultStale = await evaluateDeploymentFreeze({ maxAgeMs: 60_000 }, staleProvider);
  assert.equal(resultStale.disposition, "BLOCK");
  assert.equal(resultStale.code, "STALE_FREEZE_INFORMATION");
  assert.equal(resultStale.allowed, false);
  assert.match(resultStale.reason, /exceeds threshold/);

  // 5b. Missing or unparseable timestamp
  const invalidProvider = createMockProvider({
    timestamp: "not-a-timestamp",
    activeCompetitions: [],
    scoringMatches: [],
  });

  const resultInvalid = await evaluateDeploymentFreeze({}, invalidProvider);
  assert.equal(resultInvalid.disposition, "BLOCK");
  assert.equal(resultInvalid.code, "STALE_FREEZE_INFORMATION");
  assert.equal(resultInvalid.allowed, false);

  // 5c. Timestamp in the future (> 30s ahead)
  const futureTime = new Date(Date.now() + 60_000).toISOString();
  const futureProvider = createMockProvider({
    timestamp: futureTime,
    activeCompetitions: [],
    scoringMatches: [],
  });

  const resultFuture = await evaluateDeploymentFreeze({}, futureProvider);
  assert.equal(resultFuture.disposition, "BLOCK");
  assert.equal(resultFuture.code, "STALE_FREEZE_INFORMATION");
  assert.equal(resultFuture.allowed, false);
  assert.match(resultFuture.reason, /in the future/);
});

test("6. FREEZE_PROVIDER_UNAVAILABLE blocks deployment fail-closed on provider failure or timeouts", async () => {
  // 6a. Provider throws database error
  const failingProvider = {
    async getSnapshot() {
      throw new Error("connect ECONNREFUSED 172.31.0.2:5432");
    },
  };

  const resultErr = await evaluateDeploymentFreeze({}, failingProvider);
  assert.equal(resultErr.disposition, "BLOCK");
  assert.equal(resultErr.status, "BLOCK");
  assert.equal(resultErr.code, "FREEZE_PROVIDER_UNAVAILABLE");
  assert.equal(resultErr.allowed, false);
  assert.match(resultErr.reason, /ECONNREFUSED/);

  // 6b. Provider returns null
  const nullProvider = {
    async getSnapshot() {
      return null;
    },
  };

  const resultNull = await evaluateDeploymentFreeze({}, nullProvider);
  assert.equal(resultNull.disposition, "BLOCK");
  assert.equal(resultNull.code, "FREEZE_PROVIDER_UNAVAILABLE");
  assert.equal(resultNull.allowed, false);
});

test("7. UNKNOWN_COMPETITION_STATE blocks deployment on corrupted or unknown lifecycle states", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [],
    scoringMatches: [],
    competitions: [{ id: "comp-corrupted-1", name: "Bad State Comp", status: "invalid_state_enum" }],
  });

  const result = await evaluateDeploymentFreeze({}, provider);
  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.code, "UNKNOWN_COMPETITION_STATE");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /invalid_state_enum/);
});

test("8. UNAUTHORISED_OVERRIDE blocks deployment when override token, reason, or confirmation is invalid", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
  });

  // 8a. Wrong override secret
  const resBadSecret = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      overrideSecret: "wrong-secret-token",
      expectedOverrideSecret: "valid-production-secret-9999",
      overrideReason: "Emergency bugfix approved by organisers",
      organiserNotified: true,
    },
    provider,
  );
  assert.equal(resBadSecret.disposition, "BLOCK");
  assert.equal(resBadSecret.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(resBadSecret.allowed, false);
  assert.match(resBadSecret.reason, /invalid or missing override secret/);

  // 8b. Missing reason (or too short)
  const resNoReason = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      overrideSecret: "valid-production-secret-9999",
      expectedOverrideSecret: "valid-production-secret-9999",
      overrideReason: "short",
      organiserNotified: true,
    },
    provider,
  );
  assert.equal(resNoReason.disposition, "BLOCK");
  assert.equal(resNoReason.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(resNoReason.allowed, false);
  assert.match(resNoReason.reason, /insufficient override reason/);

  // 8c. Organiser notification not confirmed
  const resNoNotification = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      overrideSecret: "valid-production-secret-9999",
      expectedOverrideSecret: "valid-production-secret-9999",
      overrideReason: "Valid bugfix justification for production",
      organiserNotified: false,
    },
    provider,
  );
  assert.equal(resNoNotification.disposition, "BLOCK");
  assert.equal(resNoNotification.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(resNoNotification.allowed, false);
  assert.match(resNoNotification.reason, /organiser notification not affirmed/);

  // 8d. Secretless override attempt with trusted secret configured fails closed
  const resSecretless = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      expectedOverrideSecret: "valid-production-secret-9999",
      overrideReason: "Emergency bugfix approved by organisers",
      organiserNotified: true,
    },
    provider,
  );
  assert.equal(resSecretless.disposition, "BLOCK");
  assert.equal(resSecretless.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(resSecretless.allowed, false);
  assert.match(resSecretless.reason, /invalid or missing override secret/);

  // 8e. Arbitrary injected secret when no trusted secret is configured fails closed
  const resNoExpected = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      overrideSecret: "arbitrary-attacker-secret",
      overrideReason: "Emergency bugfix approved by organisers",
      organiserNotified: true,
    },
    provider,
  );
  assert.equal(resNoExpected.disposition, "BLOCK");
  assert.equal(resNoExpected.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(resNoExpected.allowed, false);
  assert.match(resNoExpected.reason, /invalid or missing override secret/);
});

test("9. EXPLICIT_AUTHORISED_OVERRIDE allows deployment under policy control when verified", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "National Canoe Polo League", status: "active" }],
    scoringMatches: [],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      overrideSecret: "valid-production-secret-9999",
      expectedOverrideSecret: "valid-production-secret-9999",
      overrideReason: "Organiser-approved scoring calculation fix for live bracket",
      organiserNotified: true,
    },
    provider,
  );

  assert.equal(result.disposition, "POLICY_CONTROLLED");
  assert.equal(result.status, "ALLOW");
  assert.equal(result.code, "EXPLICIT_AUTHORISED_OVERRIDE");
  assert.equal(result.allowed, true);
  assert.equal(result.overrideApplied, true);
  assert.match(result.reason, /Deployment freeze override authorized/);
});

test("10. EMERGENCY_ROLLBACK allows deployment safely without evaluating competition state", async () => {
  // Even if provider throws an error and there are active matches, emergency rollback MUST NEVER be blocked
  const crashingProvider = {
    async getSnapshot() {
      throw new Error("FATAL: Database completely unavailable");
    },
  };

  // 10a. Explicit emergencyRollback flag
  const res1 = await evaluateDeploymentFreeze({ emergencyRollback: true }, crashingProvider);
  assert.equal(res1.disposition, "ALLOWED_SAFELY");
  assert.equal(res1.status, "ALLOW");
  assert.equal(res1.code, "EMERGENCY_ROLLBACK");
  assert.equal(res1.allowed, true);

  // 10b. MATCHDAY_EMERGENCY_ROLLBACK=1 env var
  const res2 = await evaluateDeploymentFreeze({ env: { MATCHDAY_EMERGENCY_ROLLBACK: "1" } }, crashingProvider);
  assert.equal(res2.disposition, "ALLOWED_SAFELY");
  assert.equal(res2.code, "EMERGENCY_ROLLBACK");
  assert.equal(res2.allowed, true);

  // 10c. ROLLBACK_IN_PROGRESS=1 env var
  const res3 = await evaluateDeploymentFreeze({ env: { ROLLBACK_IN_PROGRESS: "1" } }, crashingProvider);
  assert.equal(res3.disposition, "ALLOWED_SAFELY");
  assert.equal(res3.code, "EMERGENCY_ROLLBACK");
  assert.equal(res3.allowed, true);
});

test("11. OPS002_ROLLBACK_REGRESSION contract guarantees hold", () => {
  // Validates constant mappings and timingSafeEqual helper stability
  assert.equal(timingSafeEqualStrings("secretA", "secretA"), true);
  assert.equal(timingSafeEqualStrings("secretA", "secretB"), false);
  assert.equal(timingSafeEqualStrings("secretA", "short"), false);
  assert.equal(timingSafeEqualStrings("", "secret"), false);

  assert.equal(VALID_COMPETITION_STATUSES.has("active"), true);
  assert.equal(VALID_COMPETITION_STATUSES.has("live"), true);
  assert.equal(VALID_COMPETITION_STATUSES.has("completed"), true);
  assert.equal(ACTIVE_COMPETITION_STATUSES.has("active"), true);
  assert.equal(ACTIVE_COMPETITION_STATUSES.has("live"), true);
  assert.equal(ACTIVE_COMPETITION_STATUSES.has("draft"), false);
});

test("12. CLI execution exits 0 on ALLOW and 1 on BLOCK with receipt emitted", (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "matchday-freeze-cli-test-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const envFile = path.join(tmpDir, ".env.prod");
  writeFileSync(envFile, "POSTGRES_USER=test\nPOSTGRES_DB=test\nDEPLOY_FREEZE_OVERRIDE_SECRET=test-secret-1234\n");

  // 12a. Simulation: NO_ACTIVE_COMPETITION via mock env in test mode -> exit 0
  const runAllow = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_LOG: "1",
    },
    encoding: "utf8",
  });
  assert.equal(runAllow.status, 0, runAllow.stderr);
  assert.match(runAllow.stdout, /ALLOW \(NO_ACTIVE_COMPETITION\)/);

  // 12b. Simulation: ACTIVE_COMPETITION -> exit 1
  const runBlock = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "1",
    },
    encoding: "utf8",
  });
  assert.equal(runBlock.status, 1);
  assert.match(runBlock.stderr, /Deployment blocked by freeze policy: ACTIVE_COMPETITION/);

  // 12c. Simulation: SCORING_IN_PROGRESS -> exit 1
  const runScoring = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_FREEZE_SCORING: "1",
    },
    encoding: "utf8",
  });
  assert.equal(runScoring.status, 1);
  assert.match(runScoring.stderr, /Deployment blocked by freeze policy: SCORING_IN_PROGRESS/);

  // 12d. Simulation: EXPLICIT_AUTHORISED_OVERRIDE -> exit 0
  const runOverride = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "1",
      DEPLOY_FREEZE_OVERRIDE: "1",
      DEPLOY_FREEZE_OVERRIDE_SECRET: "test-secret-1234",
      DEPLOY_FREEZE_OVERRIDE_REASON: "Organiser authorized urgent hotfix",
      DEPLOY_FREEZE_ORGANISER_NOTIFIED: "true",
    },
    encoding: "utf8",
  });
  assert.equal(runOverride.status, 0, runOverride.stderr);
  assert.match(runOverride.stdout, /POLICY_CONTROLLED \(EXPLICIT_AUTHORISED_OVERRIDE\)/);

  // 12e. Simulation: EMERGENCY_ROLLBACK bypass -> exit 0
  const runRollback = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "2",
      MATCHDAY_EMERGENCY_ROLLBACK: "1",
    },
    encoding: "utf8",
  });
  assert.equal(runRollback.status, 0, runRollback.stderr);
  assert.match(runRollback.stdout, /ALLOWED_SAFELY \(EMERGENCY_ROLLBACK\)/);
});

test("13. Secretless override attempt with .env.prod configured fails closed (exit 1)", (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "matchday-freeze-sec1-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const envFile = path.join(tmpDir, ".env.prod");
  writeFileSync(
    envFile,
    "POSTGRES_USER=test\nPOSTGRES_DB=test\nDEPLOY_FREEZE_OVERRIDE_SECRET=test-override-secret-1234\n",
  );

  const cleanEnv = { ...process.env };
  delete cleanEnv.DEPLOY_FREEZE_OVERRIDE_SECRET;
  delete cleanEnv.DEPLOY_FREEZE_OVERRIDE_TOKEN;
  delete cleanEnv.DEPLOY_FREEZE_OVERRIDE_SECRET_TOKEN;

  const res = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...cleanEnv,
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "1",
      DEPLOY_FREEZE_OVERRIDE: "1",
      DEPLOY_FREEZE_OVERRIDE_REASON: "Attempting secretless override",
      DEPLOY_FREEZE_ORGANISER_NOTIFIED: "1",
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 1, `Expected exit 1 but got ${res.status}: ${res.stdout}`);
  assert.match(res.stderr, /Deployment blocked by freeze policy: UNAUTHORISED_OVERRIDE/);
  assert.match(res.stderr, /invalid or missing override secret/);
});

test("14. Arbitrary injected secret when .env.prod has no override secret fails closed (exit 1)", (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "matchday-freeze-sec2-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const envFile = path.join(tmpDir, ".env.prod");
  writeFileSync(envFile, "POSTGRES_USER=test\nPOSTGRES_DB=test\n");

  const res = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "1",
      DEPLOY_FREEZE_OVERRIDE: "1",
      DEPLOY_FREEZE_OVERRIDE_SECRET: "attacker_secret_999",
      DEPLOY_FREEZE_OVERRIDE_REASON: "Attempting arbitrary injected secret",
      DEPLOY_FREEZE_ORGANISER_NOTIFIED: "1",
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 1, `Expected exit 1 but got ${res.status}: ${res.stdout}`);
  assert.match(res.stderr, /Deployment blocked by freeze policy: UNAUTHORISED_OVERRIDE/);
  assert.match(res.stderr, /invalid or missing override secret/);
});
