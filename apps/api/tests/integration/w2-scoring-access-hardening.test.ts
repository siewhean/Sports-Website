import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { reconcileScoringFallbackHmacKeyring } from "../../src/scoring-fallback-hmac-keyring.js";

/**
 * Week-2 scoring-access hardening: number codes need match/competition context and never reveal
 * whether a guess hit a revoked/expired/other-match pass; an expired writer lease can only be
 * resumed silently by the same device, other devices need organiser approval.
 */
const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_w2_scoring_access_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const fallbackSecret = "w2-scoring-access-fallback-secret-32-bytes-min";
let sql: Sql;
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);

function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

async function seedMatch(admin: string) {
  const organisationId = randomUUID();
  const competitionId = randomUUID();
  const divisionId = randomUUID();
  const revisionId = randomUUID();
  const matchId = randomUUID();
  const otherMatchId = randomUUID();
  const entries = [randomUUID(), randomUUID()];
  const graph = {
    id: revisionId,
    schemaVersion: 1,
    entryCount: 2,
    stages: [
      {
        id: "final-stage",
        label: "Final",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [matchId],
      },
    ],
    matches: [
      {
        id: matchId,
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: [matchId],
  };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organisations(id,name,slug) VALUES(${organisationId},'W2 access org',${`w2-access-${randomUUID()}`})`;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status) VALUES(${organisationId},${admin},'owner','active')`;
  });
  await sql`INSERT INTO competitions(id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
    VALUES(${competitionId},${organisationId},${admin},'W2 access competition',${`w2-access-${randomUUID()}`},'canoe_polo','UTC','2030-01-01','2030-01-01')`;
  await sql`INSERT INTO divisions(id,competition_id,name,team_limit) VALUES(${divisionId},${competitionId},'Open',8)`;
  await sql`INSERT INTO format_revisions(id,competition_id,division_id,revision,definition,definition_hash,status,created_by,validation_contract)
    VALUES(${revisionId},${competitionId},${divisionId},1,${sql.json(graph)},${canonicalHash(graph)},'draft',${admin},'phase3')`;
  await sql`INSERT INTO division_entries(id,division_id,name,seed)
    VALUES(${entries[0]!},${divisionId},'Home',1),(${entries[1]!},${divisionId},'Away',2)`;
  await sql`INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,home_entry_id,away_entry_id)
    VALUES(${matchId},${competitionId},${divisionId},${revisionId},'M1','group',1,1,${entries[0]!},${entries[1]!}),
          (${otherMatchId},${competitionId},${divisionId},${revisionId},'M2','group',1,2,${entries[0]!},${entries[1]!})`;
  return { competitionId, matchId, otherMatchId };
}

describeInfra("week-2 scoring access hardening", () => {
  let runtime: Phase2Runtime;
  let admin: string;

  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
    admin = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${admin},${`${admin}@example.test`},'W2 admin')`;
    await reconcileScoringFallbackHmacKeyring(
      sql as unknown as PostgresJsSql,
      { primary: { version: "v1", secret: fallbackSecret }, verificationOnly: [] },
      new Date(),
    );
    runtime = new Phase2Runtime(sql as unknown as PostgresJsSql, phase2DomainAdapter, clock, undefined, fallbackSecret);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  const issue = async (competitionId: string, matchId: string) => {
    const pass = await runtime.createAccessPass(
      { accountId: admin },
      competitionId,
      matchId,
      {
        expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        role: "scorekeeper",
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    if (!pass.short_code) throw new Error("expected a fallback code");
    return pass as typeof pass & { short_code: string };
  };

  it("requires match or competition context for number codes and answers every miss identically", async () => {
    const { competitionId, matchId, otherMatchId } = await seedMatch(admin);
    const pass = await issue(competitionId, matchId);
    const exchange = (extra: Record<string, string>) =>
      runtime.exchangeAccess(
        { shortCode: pass.short_code, deviceId: randomUUID(), ipAddress: "203.0.113.10", ...extra },
        randomUUID(),
      );

    await expect(exchange({})).rejects.toMatchObject({ statusCode: 403, code: "ACCESS_DENIED" });
    // A real code presented for a different match is indistinguishable from a wrong code.
    await expect(exchange({ expectedMatchId: otherMatchId })).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCESS_DENIED",
    });
    await expect(exchange({ expectedCompetitionId: randomUUID() })).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCESS_DENIED",
    });
    await expect(exchange({ expectedCompetitionId: competitionId })).resolves.toMatchObject({
      match_id: matchId,
      mode: "writer",
    });

    await runtime.revokeAccessPass({ accountId: admin }, competitionId, pass.id, randomUUID(), "w2 test revoke");
    // Revocation must not be distinguishable for guessable codes (the attempt log keeps the truth).
    await expect(exchange({ expectedMatchId: matchId })).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCESS_DENIED",
    });
    const outcomes = await sql<{ outcome: string }[]>`
      SELECT outcome FROM scoring_access_attempts WHERE access_pass_id=${pass.id} ORDER BY attempted_at`;
    expect(outcomes.map((row) => row.outcome)).toContain("revoked");
  });

  it("binds an expired writer lease to the original device and audits writer changes", async () => {
    const { competitionId, matchId } = await seedMatch(admin);
    const pass = await issue(competitionId, matchId);
    const originalDevice = randomUUID();
    const first = await runtime.exchangeAccess(
      { shortCode: pass.short_code, expectedMatchId: matchId, deviceId: originalDevice, ipAddress: "203.0.113.20" },
      randomUUID(),
    );
    expect(first.mode).toBe("writer");

    clockOffsetMs = 60_000; // the scorer has been offline longer than the 45 s lease
    try {
      const intruder = await runtime.exchangeAccess(
        { shortCode: pass.short_code, expectedMatchId: matchId, deviceId: randomUUID(), ipAddress: "203.0.113.21" },
        randomUUID(),
      );
      expect(intruder.mode).toBe("candidate");
      expect(intruder.generation).toBeNull();

      // The candidate can still ask the organiser even though the incumbent's lease has lapsed.
      await expect(
        runtime.requestTakeover(
          { sessionId: intruder.session_id, sessionToken: intruder.session_token, generation: null },
          { pendingEventCount: 0, pendingThroughSequence: 0 },
          randomUUID(),
        ),
      ).resolves.toMatchObject({ status: "pending", incumbent_pending_state: "unknown" });

      const resumed = await runtime.exchangeAccess(
        { shortCode: pass.short_code, expectedMatchId: matchId, deviceId: originalDevice, ipAddress: "203.0.113.20" },
        randomUUID(),
      );
      expect(resumed.mode).toBe("writer");
      expect(resumed.generation).toBe((first.generation ?? 0) + 1);
    } finally {
      clockOffsetMs = 0;
    }

    const changes = await sql<{ after_state: { same_device: boolean } }[]>`
      SELECT after_state FROM audit_events
      WHERE action='scoring_writer.changed' AND metadata->>'competition_id'=${competitionId}`;
    expect(changes).toHaveLength(1);
    expect(changes[0]!.after_state.same_device).toBe(true);
  });

  it("lets an organiser approve a takeover of a lapsed lease with explicit acknowledgement", async () => {
    const { competitionId, matchId } = await seedMatch(admin);
    const pass = await issue(competitionId, matchId);
    await runtime.exchangeAccess(
      { shortCode: pass.short_code, expectedMatchId: matchId, deviceId: randomUUID(), ipAddress: "203.0.113.30" },
      randomUUID(),
    );
    clockOffsetMs = 60_000;
    try {
      const candidate = await runtime.exchangeAccess(
        { shortCode: pass.short_code, expectedMatchId: matchId, deviceId: randomUUID(), ipAddress: "203.0.113.31" },
        randomUUID(),
      );
      const request = await runtime.requestTakeover(
        { sessionId: candidate.session_id, sessionToken: candidate.session_token, generation: null },
        { pendingEventCount: 0, pendingThroughSequence: 0 },
        randomUUID(),
      );
      await expect(
        runtime.resolveTakeover(
          { accountId: admin },
          competitionId,
          request.id,
          { decision: "approve", overrideAcknowledged: false, reason: "Phone died" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "TAKEOVER_OVERRIDE_ACKNOWLEDGEMENT_REQUIRED" });
      await expect(
        runtime.resolveTakeover(
          { accountId: admin },
          competitionId,
          request.id,
          { decision: "approve", overrideAcknowledged: true, reason: "Phone died" },
          randomUUID(),
        ),
      ).resolves.toMatchObject({ status: "approved" });
    } finally {
      clockOffsetMs = 0;
    }
  });
});
