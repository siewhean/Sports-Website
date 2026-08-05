import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_gate_c_access_collision_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const fallbackCodeHmacSecret = "gate-c-access-collision-fallback-hmac-secret";
const accessExpiry = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

let client: Sql;
let accountId: string;
let organisationId: string;
let competitionId: string;
let matchIds: string[];

function fallbackHash(value: string): Buffer {
  return createHmac("sha256", fallbackCodeHmacSecret).update(`scoring-fallback-code:${value}`, "utf8").digest();
}

function codeGenerator(values: readonly string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function runtimeWithCodes(values: readonly string[]): Phase2Runtime {
  return new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    fallbackCodeHmacSecret,
    codeGenerator(values),
  );
}

async function issueWithCode(code: string, matchId: string, label: string) {
  return runtimeWithCodes([code]).createAccessPass(
    { accountId },
    competitionId,
    matchId,
    {
      expiresAt: accessExpiry,
      role: "viewer",
      idempotencyKey: `${label}-${randomUUID()}`,
    },
    randomUUID(),
  );
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  const accounts = await client<{ id: string }[]>`
    INSERT INTO accounts (primary_email,display_name,email_verified_at)
    VALUES ('gate-c-collision@matchday.test','Gate C collision tester',now()) RETURNING id
  `;
  accountId = accounts[0]?.id ?? "";
  await client.begin(async (tx) => {
    const organisations = await tx<{ id: string }[]>`
      INSERT INTO organisations (name,slug) VALUES ('Gate C Collision Org','gate-c-collision-org') RETURNING id
    `;
    organisationId = organisations[0]?.id ?? "";
    await tx`
      INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${accountId},'owner','active')
    `;
  });

  const runtime = new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    fallbackCodeHmacSecret,
  );
  const competition = await runtime.createCompetition(
    { accountId },
    {
      organisationId,
      name: "Gate C Collision Cup",
      slug: `gate-c-collision-${randomUUID()}`,
      timezone: "Asia/Singapore",
      startsOn: "2026-10-01",
      endsOn: "2026-10-01",
    },
    randomUUID(),
  );
  competitionId = competition.id;
  const division = await runtime.createDivision(
    { accountId },
    competition.id,
    { name: "Open", teamLimit: 8 },
    randomUUID(),
  );
  await runtime.replaceEntries(
    { accountId },
    competition.id,
    division.id,
    Array.from({ length: 8 }, (_, index) => ({ name: `Team ${index + 1}`, seed: index + 1 })),
    randomUUID(),
  );
  await runtime.replaceCapacity(
    { accountId },
    competition.id,
    [
      {
        name: "Court 1",
        windows: [{ startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z" }],
      },
    ],
    randomUUID(),
  );
  const format = await runtime.generateFormat({ accountId }, competition.id, division.id, randomUUID());
  matchIds = format.matches
    .filter((match) => match.homeEntryId && match.awayEntryId)
    .slice(0, 4)
    .map((match) => match.id);
  if (matchIds.length < 4) throw new Error("Expected four resolved matches for collision tests");
});

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describe("Gate C fallback-code collision safety", () => {
  it("retries only active-code collisions and records counts without secrets", async () => {
    const [firstMatch, secondMatch, thirdMatch, fourthMatch] = matchIds;
    if (!firstMatch || !secondMatch || !thirdMatch || !fourthMatch) throw new Error("Collision fixtures missing");
    const collisionCodes = ["111111111111", "222222222222", "333333333333"] as const;
    await issueWithCode(collisionCodes[0], firstMatch, "collision-seed-one");
    await issueWithCode(collisionCodes[1], secondMatch, "collision-seed-two");
    await issueWithCode(collisionCodes[2], thirdMatch, "collision-seed-three");

    const oneCollisionRequestId = randomUUID();
    const oneCollision = await runtimeWithCodes([collisionCodes[0], "444444444444"]).createAccessPass(
      { accountId },
      competitionId,
      fourthMatch,
      {
        expiresAt: accessExpiry,
        role: "viewer",
        idempotencyKey: `one-collision-${randomUUID()}`,
      },
      oneCollisionRequestId,
    );
    expect(oneCollision.short_code).toBe("444444444444");
    if (!oneCollision.short_code) throw new Error("Expected one-time fallback code");
    const exchanged = await runtimeWithCodes(["999999999999"]).exchangeAccess(
      {
        shortCode: oneCollision.short_code,
        deviceId: randomUUID(),
        deviceLabel: "Collision-safe viewer",
        ipAddress: "198.51.100.90",
      },
      randomUUID(),
    );
    expect(exchanged).toMatchObject({ match_id: fourthMatch, mode: "viewer" });

    const multipleCollisionRequestId = randomUUID();
    const multipleCollision = await runtimeWithCodes([...collisionCodes, "555555555555"]).createAccessPass(
      { accountId },
      competitionId,
      fourthMatch,
      {
        expiresAt: accessExpiry,
        role: "viewer",
        idempotencyKey: `multiple-collision-${randomUUID()}`,
      },
      multipleCollisionRequestId,
    );
    expect(multipleCollision.short_code).toBe("555555555555");

    const evidence = await client<{ request_id: string; collision_count: number; evidence: string }[]>`
      SELECT request_id,
             COALESCE((metadata->>'fallback_code_collision_count')::integer,-1) AS collision_count,
             concat_ws(' ',before_state::text,after_state::text,metadata::text) AS evidence
      FROM audit_events
      WHERE request_id IN (${oneCollisionRequestId},${multipleCollisionRequestId})
        AND action='scoring_access.created'
      ORDER BY request_id
    `;
    expect(new Map(evidence.map((row) => [row.request_id, row.collision_count]))).toEqual(
      new Map([
        [oneCollisionRequestId, 1],
        [multipleCollisionRequestId, 3],
      ]),
    );
    const evidenceText = evidence.map((row) => row.evidence).join("\n");
    for (const secret of [...collisionCodes, "444444444444", "555555555555"]) {
      expect(evidenceText).not.toContain(secret);
      expect(evidenceText).not.toContain(fallbackHash(secret).toString("hex"));
    }
  });

  it("fails closed after bounded issuance attempts and leaves no partial pass", async () => {
    const firstMatch = matchIds[0];
    if (!firstMatch) throw new Error("Collision fixture missing");
    const collisionCode = "611111111111";
    await issueWithCode(collisionCode, firstMatch, "exhaustion-seed");
    const idempotencyKey = `collision-exhaustion-${randomUUID()}`;
    await expect(
      runtimeWithCodes([collisionCode]).createAccessPass(
        { accountId },
        competitionId,
        firstMatch,
        { expiresAt: accessExpiry, role: "viewer", idempotencyKey },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "ACCESS_CODE_UNAVAILABLE" });
    const rows = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM scoring_access_passes
      WHERE competition_id=${competitionId} AND issuance_idempotency_key=${idempotencyKey}
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("retries rotation collisions and preserves the prior code when all attempts collide", async () => {
    const [firstMatch, secondMatch] = matchIds;
    if (!firstMatch || !secondMatch) throw new Error("Collision fixtures missing");
    const collisionCode = "711111111111";
    await issueWithCode(collisionCode, firstMatch, "rotation-collision-seed");
    const target = await issueWithCode("722222222222", secondMatch, "rotation-target");
    const requestId = randomUUID();
    const rotated = await runtimeWithCodes([collisionCode, "733333333333"]).rotateFallbackCode(
      { accountId },
      competitionId,
      target.id,
      `rotate-collision-${randomUUID()}`,
      requestId,
    );
    expect(rotated).toMatchObject({ short_code: "733333333333", duplicate: false });
    const audit = await client<{ collision_count: number; evidence: string }[]>`
      SELECT COALESCE((metadata->>'fallback_code_collision_count')::integer,-1) AS collision_count,
             concat_ws(' ',before_state::text,after_state::text,metadata::text) AS evidence
      FROM audit_events WHERE request_id=${requestId} AND action='scoring_access.fallback_rotated'
    `;
    expect(audit[0]?.collision_count).toBe(1);
    expect(audit[0]?.evidence).not.toContain("733333333333");

    await expect(
      runtimeWithCodes([collisionCode]).rotateFallbackCode(
        { accountId },
        competitionId,
        target.id,
        `rotate-exhaustion-${randomUUID()}`,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "ACCESS_CODE_UNAVAILABLE" });
    const retained = await client<{ short_code_hash: Buffer }[]>`
      SELECT short_code_hash FROM scoring_access_passes WHERE id=${target.id}
    `;
    expect(retained[0]?.short_code_hash).toEqual(fallbackHash("733333333333"));
  });

  it("does not retry unrelated database failures", async () => {
    const firstMatch = matchIds[0];
    if (!firstMatch) throw new Error("Collision fixture missing");
    await client.unsafe(`
      CREATE FUNCTION force_gate_c_access_insert_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.issuance_idempotency_key LIKE 'forced-error-%' THEN
          RAISE EXCEPTION 'forced unrelated insert failure' USING ERRCODE='P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.unsafe(`
      CREATE TRIGGER force_gate_c_access_insert_failure
      BEFORE INSERT ON scoring_access_passes
      FOR EACH ROW EXECUTE FUNCTION force_gate_c_access_insert_failure()
    `);
    let generatorCalls = 0;
    const failingRuntime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      undefined,
      fallbackCodeHmacSecret,
      () => {
        generatorCalls += 1;
        return "811111111111";
      },
    );
    try {
      await expect(
        failingRuntime.createAccessPass(
          { accountId },
          competitionId,
          firstMatch,
          {
            expiresAt: accessExpiry,
            role: "viewer",
            idempotencyKey: `forced-error-${randomUUID()}`,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(generatorCalls).toBe(1);
    } finally {
      await client.unsafe(`DROP TRIGGER force_gate_c_access_insert_failure ON scoring_access_passes`);
      await client.unsafe(`DROP FUNCTION force_gate_c_access_insert_failure()`);
    }
  });

  it("keeps concurrent idempotent issuance atomic", async () => {
    const firstMatch = matchIds[0];
    if (!firstMatch) throw new Error("Collision fixture missing");
    const idempotencyKey = `concurrent-issue-${randomUUID()}`;
    const runtime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      undefined,
      fallbackCodeHmacSecret,
    );
    const results = await Promise.all(
      [randomUUID(), randomUUID()].map((requestId) =>
        runtime.createAccessPass(
          { accountId },
          competitionId,
          firstMatch,
          { expiresAt: accessExpiry, role: "viewer", idempotencyKey },
          requestId,
        ),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.token !== null)).toHaveLength(1);
  });
});
