import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  VALID_MATCH_STATES,
  VALID_DELIVERY_STATUSES,
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

function createValidNotificationEvidence(overrides = {}) {
  return {
    notification_id: "notif-delivery-1001",
    competition_id: "comp-1",
    recipient_or_organiser_reference: "organiser@canoe-polo.sg",
    notification_timestamp: new Date().toISOString(),
    delivery_or_acknowledgement_status: "delivered",
    evidence_source: "email_delivery_webhook",
    ...overrides,
  };
}

function createValidAuthorization(overrides = {}) {
  return {
    operator_id: "operator:siewhean",
    reason: "Urgent scoring patch authorized by lead organiser",
    scope: "all",
    valid_until: new Date(Date.now() + 3600_000).toISOString(),
    token: "valid-production-secret-9999",
    nonce: "nonce-auth-20261008-01",
    ...overrides,
  };
}

test("1. NO_ACTIVE_COMPETITION allows deployment when zero active competitions exist", async () => {
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
    competitions: [],
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
    competitions: [],
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
    competitions: [],
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

test("7. UNKNOWN_COMPETITION_STATE blocks deployment on corrupted lifecycle states", async () => {
  // 7a. Corrupted competition status
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

  // 7b. Corrupted match state
  const providerMatch = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Comp 1", status: "active" }],
    scoringMatches: [{ id: "match-1", competition_id: "comp-1", state: "corrupted_match_state" }],
    competitions: [{ id: "comp-1", name: "Comp 1", status: "active" }],
  });
  const resMatch = await evaluateDeploymentFreeze({}, providerMatch);
  assert.equal(resMatch.disposition, "BLOCK");
  assert.equal(resMatch.code, "UNKNOWN_COMPETITION_STATE");
  assert.match(resMatch.reason, /Unknown match state/);
});

test("8. CALLER_NOTIFICATION_BOOLEAN_ONLY rejects caller-supplied boolean without verifiable notification evidence", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization(),
      organiserNotified: true, // Only boolean supplied!
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "CALLER_NOTIFICATION_BOOLEAN_ONLY");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Caller-supplied organiser notification boolean rejected/);
});

test("9. MISSING_OPERATOR_AUTHORIZATION blocks when operator identity is missing", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization({ operator_id: "" }),
      notificationEvidence: createValidNotificationEvidence(),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "MISSING_OPERATOR_AUTHORIZATION");
  assert.equal(result.allowed, false);
});

test("10. EXPIRED_AUTHORIZATION blocks when authorization validity has expired", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization({
        valid_until: new Date(Date.now() - 60_000).toISOString(),
      }),
      notificationEvidence: createValidNotificationEvidence(),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "EXPIRED_AUTHORIZATION");
  assert.equal(result.allowed, false);
});

test("11. INVALID_OVERRIDE_SCOPE blocks when authorization scope does not cover active competition", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-other", name: "Other Tournament", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-other", name: "Other Tournament", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization({ scope: "comp-1" }), // does not cover comp-other
      notificationEvidence: createValidNotificationEvidence({ competition_id: "comp-other" }),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "INVALID_OVERRIDE_SCOPE");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /comp-other/);
});

test("12. MISSING_NOTIFICATION_EVIDENCE blocks when notification record is missing", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization(),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "MISSING_NOTIFICATION_EVIDENCE");
  assert.equal(result.allowed, false);
});

test("13. INVALID_NOTIFICATION_EVIDENCE blocks on unconfirmed or malformed notification records", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  // 13a. Delivery status not confirmed
  const resBadStatus = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization(),
      notificationEvidence: createValidNotificationEvidence({
        delivery_or_acknowledgement_status: "bounced",
      }),
    },
    provider,
  );
  assert.equal(resBadStatus.disposition, "BLOCK");
  assert.equal(resBadStatus.code, "INVALID_NOTIFICATION_EVIDENCE");
  assert.equal(resBadStatus.allowed, false);

  // 13b. Notification timestamp too old (> 24h)
  const resOldNotif = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization(),
      notificationEvidence: createValidNotificationEvidence({
        notification_timestamp: new Date(Date.now() - 100_000_000).toISOString(),
      }),
    },
    provider,
  );
  assert.equal(resOldNotif.disposition, "BLOCK");
  assert.equal(resOldNotif.code, "INVALID_NOTIFICATION_EVIDENCE");
});

test("14. Matching credentials and self-declared delivered notification cannot override an active competition", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "National Canoe Polo League", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "National Canoe Polo League", status: "active" }],
  });

  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization(),
      notificationEvidence: createValidNotificationEvidence(),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.code, "OVERRIDE_EVIDENCE_NOT_VERIFIABLE");
  assert.equal(result.allowed, false);
  assert.equal(result.overrideApplied, false);
  assert.match(result.reason, /not independently verifiable/);
});

test("15. Scoring HMAC secret is REJECTED as deployment authorization credential", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  // Configuration ONLY defines scoring HMAC secret, but NO DEPLOY_FREEZE_OVERRIDE_SECRET
  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "scoring-hmac-secret-1234" },
      authorization: createValidAuthorization({ token: "scoring-hmac-secret-1234" }),
      notificationEvidence: createValidNotificationEvidence(),
    },
    provider,
  );

  assert.equal(result.disposition, "BLOCK");
  assert.equal(result.code, "UNAUTHORISED_OVERRIDE");
  assert.equal(result.allowed, false);
});

test("16. Emergency rollback environment flags DO NOT bypass freeze check in evaluateDeploymentFreeze", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    activeCompetitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
    scoringMatches: [],
    competitions: [{ id: "comp-1", name: "Tournament 1", status: "active" }],
  });

  // Attempt to pass MATCHDAY_EMERGENCY_ROLLBACK=1 via environment
  const res1 = await evaluateDeploymentFreeze({ env: { MATCHDAY_EMERGENCY_ROLLBACK: "1" } }, provider);
  assert.equal(res1.disposition, "BLOCK");
  assert.equal(res1.code, "ACTIVE_COMPETITION");
  assert.equal(res1.allowed, false);

  // Attempt to pass ROLLBACK_IN_PROGRESS=1 via environment
  const res2 = await evaluateDeploymentFreeze({ env: { ROLLBACK_IN_PROGRESS: "1" } }, provider);
  assert.equal(res2.disposition, "BLOCK");
  assert.equal(res2.code, "ACTIVE_COMPETITION");
  assert.equal(res2.allowed, false);

  // Genuine programmatic rollback flag is permitted
  const resRollback = await evaluateDeploymentFreeze({ isRollbackOperation: true }, provider);
  assert.equal(resRollback.disposition, "ALLOWED_SAFELY");
  assert.equal(resRollback.code, "EMERGENCY_ROLLBACK");
  assert.equal(resRollback.allowed, true);
});

test("17. Durably writing audit receipt fails closed on filesystem failure", async (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "matchday-freeze-receipt-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // Make directory non-writable
  chmodSync(tmpDir, 0o400);

  const mockResult = {
    timestamp: new Date().toISOString(),
    disposition: "POLICY_CONTROLLED",
    status: "ALLOW",
    code: "EXPLICIT_AUTHORISED_OVERRIDE",
    allowed: true,
    overrideApplied: true,
    reason: "test",
    details: {},
  };

  await assert.rejects(async () => {
    await writeFreezeReceipt(mockResult, { artifactsDir: tmpDir });
  }, /AUDIT_RECEIPT_WRITE_FAILURE/);
});

test("18. Adversarial test: caller-supplied MATCHDAY_FREEZE_SNAPSHOT or MOCK_* cannot bypass CLI execution", (t) => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "matchday-freeze-adv-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const envFile = path.join(tmpDir, ".env.prod");
  writeFileSync(envFile, "POSTGRES_USER=test\nPOSTGRES_DB=test\n");

  // Adversary attempts to pass synthetic empty snapshot and mock bypass flags to CLI
  const fakeSnapshot = JSON.stringify({
    timestamp: new Date().toISOString(),
    competitions: [],
    scoringMatches: [],
  });

  const res = spawnSync("node", [policyScriptPath, envFile], {
    env: {
      ...process.env,
      MATCHDAY_FREEZE_SNAPSHOT: fakeSnapshot,
      MOCK_LOG: "1",
      MOCK_FREEZE_ACTIVE_COMPETITIONS: "0",
      MOCK_FREEZE_PROVIDER_UNAVAILABLE: "0",
      MATCHDAY_EMERGENCY_ROLLBACK: "1",
      ROLLBACK_IN_PROGRESS: "1",
    },
    encoding: "utf8",
  });

  // Because the CLI strictly attempts to execute docker compose psql (which fails in this isolated test env),
  // it MUST fail closed (exit 1) rather than accepting the fake snapshot!
  assert.equal(res.status, 1);
  assert.match(res.stderr, /FATAL: Deployment blocked by freeze policy: FREEZE_PROVIDER_UNAVAILABLE/);
});

test("19. Forged delivered notification and reused authorization nonce fail closed repeatedly", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    competitions: [{ id: "comp-1", name: "Test competition", status: "active" }],
    scoringMatches: [],
  });
  const authorization = createValidAuthorization({ nonce: "replayable-nonce" });
  const notificationEvidence = createValidNotificationEvidence({
    notification_id: "unverified-delivery-claim",
    delivery_or_acknowledgement_status: "delivered",
    evidence_source: "email_delivery_webhook",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await evaluateDeploymentFreeze(
      {
        overrideRequested: true,
        parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
        authorization,
        notificationEvidence,
      },
      provider,
    );
    assert.equal(result.code, "OVERRIDE_EVIDENCE_NOT_VERIFIABLE");
    assert.equal(result.allowed, false);
    assert.equal(result.overrideApplied, false);
  }
});

test("20. Missing authorization expiry and implicit global scope can never grant deployment override", async () => {
  const provider = createMockProvider({
    timestamp: new Date().toISOString(),
    competitions: [{ id: "comp-1", name: "Test competition", status: "active" }],
    scoringMatches: [],
  });
  const result = await evaluateDeploymentFreeze(
    {
      overrideRequested: true,
      parsedEnv: { DEPLOY_FREEZE_OVERRIDE_SECRET: "valid-production-secret-9999" },
      authorization: createValidAuthorization({
        valid_until: undefined,
        scope: undefined,
        nonce: undefined,
      }),
      notificationEvidence: createValidNotificationEvidence(),
    },
    provider,
  );
  assert.equal(result.code, "OVERRIDE_EVIDENCE_NOT_VERIFIABLE");
  assert.equal(result.status, "BLOCK");
  assert.equal(result.allowed, false);
});
