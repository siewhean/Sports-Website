import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { DRAFT_SPORT_PACK_VERSION } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { ApiError, ErrorCode } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_redesign_p4_rules_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
let client!: Sql;
let draftRuntime!: Phase3Runtime;
let federationRuntime!: Phase3Runtime;
let ownerId = "";
let organisationId = "";

function required<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (!value) throw new Error("Expected database row");
  return value;
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 8, onnotice: () => undefined, connection: { search_path: schema } });
  ownerId = required(
    await client<{ id: string }[]>`INSERT INTO accounts (primary_email,display_name,email_verified_at)
      VALUES ('owner@rules.test','Owner',now()) RETURNING id`,
  ).id;
  await client.begin(async (tx) => {
    organisationId = required(
      await tx<{ id: string }[]>`INSERT INTO organisations (name,slug) VALUES ('Rules Org','rules-org') RETURNING id`,
    ).id;
    await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status)
      VALUES (${organisationId},${ownerId},'owner','active')`;
  });
  const sql = client as unknown as PostgresJsSql;
  draftRuntime = new Phase3Runtime(sql, phase3DomainAdapter, undefined, { federationRulesEnabled: async () => false });
  federationRuntime = new Phase3Runtime(sql, phase3DomainAdapter, undefined, {
    federationRulesEnabled: async () => true,
  });
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

async function create(
  runtime: Phase3Runtime,
  sportCode: "canoe_polo" | "badminton" | "volleyball" | "basketball" | "table_tennis",
  startsOn: string,
) {
  return runtime.createCompetition(
    { accountId: ownerId },
    {
      organisationId,
      name: `Rules ${sportCode} ${startsOn}`,
      slug: `rules-${sportCode.replace("_", "-")}-${randomUUID()}`,
      sportCode,
      venue: "Hall",
      address: "1 Rules Road",
      countryCode: "SG",
      startsOn,
      endsOn: startsOn,
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
    `create-${randomUUID()}`,
  );
}

async function packVersion(competitionId: string) {
  return required(
    await client<{ pack_version: string }[]>`
      SELECT pack_version FROM competition_sport_settings WHERE competition_id=${competitionId}`,
  ).pack_version;
}

describeInfrastructure("Redesign Phase 4 sport rules", () => {
  it("keeps new competitions on the draft pack while redesign_p4_rules is off", async () => {
    const competition = await create(draftRuntime, "canoe_polo", "2027-03-01");
    expect(await packVersion(competition.id)).toBe(DRAFT_SPORT_PACK_VERSION);
  });

  it("starts new competitions from the federation pack when the flag is on, badminton by start date", async () => {
    const draft = await create(draftRuntime, "badminton", "2026-11-01");
    const before = await client`SELECT * FROM competition_sport_settings WHERE competition_id=${draft.id}`;

    const polo = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const volleyball = await create(federationRuntime, "volleyball", "2027-03-01");
    const lastDay3x21 = await create(federationRuntime, "badminton", "2027-01-03");
    const firstDay3x15 = await create(federationRuntime, "badminton", "2027-01-04");
    expect(await packVersion(polo.id)).toBe("1.0.0");
    expect(await packVersion(volleyball.id)).toBe("1.0.0");
    expect(await packVersion(lastDay3x21.id)).toBe("1.0.0");
    expect(await packVersion(firstDay3x15.id)).toBe("1.1.0");

    const settings = await federationRuntime.readSettings({ accountId: ownerId }, firstDay3x15.id);
    expect(settings).toMatchObject({ pack_version: "1.1.0", effective: { regularTargetPoints: 15, pointCap: 21 } });
    const volleyballSettings = await federationRuntime.readSettings({ accountId: ownerId }, volleyball.id);
    expect(volleyballSettings.effective).toMatchObject({ bestOf: 5 });

    // The federation packs are registered beside the draft packs; the active pack and existing rows are untouched.
    const active = await client<{ sport_code: string; version: string }[]>`
      SELECT sport_code,version FROM sport_pack_versions WHERE status='active' ORDER BY sport_code`;
    expect(active.every((row) => row.version === DRAFT_SPORT_PACK_VERSION)).toBe(true);
    const registered = await client<{ version: string; status: string }[]>`
      SELECT version,status FROM sport_pack_versions WHERE sport_code='badminton' ORDER BY version`;
    expect(registered).toEqual([
      { version: DRAFT_SPORT_PACK_VERSION, status: "active" },
      { version: "1.0.0", status: "draft" },
      { version: "1.1.0", status: "draft" },
    ]);
    expect(await client`SELECT * FROM competition_sport_settings WHERE competition_id=${draft.id}`).toEqual(before);
    expect(await packVersion(draft.id)).toBe(DRAFT_SPORT_PACK_VERSION);
  });
});

async function account(email: string): Promise<string> {
  return required(
    await client<{ id: string }[]>`INSERT INTO accounts (primary_email,display_name,email_verified_at)
      VALUES (${email},${email.split("@")[0]!},now()) RETURNING id`,
  ).id;
}

describeInfrastructure("Rules changes history", () => {
  it("increments the revision and records before, after and who on every save, and on reset", async () => {
    const competition = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const actor = { accountId: ownerId };
    const initial = await federationRuntime.readSettings(actor, competition.id);
    expect(initial.revision).toBe(1);

    const changed = await federationRuntime.updateSettings(
      actor,
      competition.id,
      { revision: 1, packVersion: "1.0.0", override: { periodDurationMinutes: 7 } },
      randomUUID(),
    );
    expect(changed).toMatchObject({ revision: 2, effective: { periodDurationMinutes: 7 } });
    const reset = await federationRuntime.updateSettings(
      actor,
      competition.id,
      { revision: 2, packVersion: "1.0.0", override: {} },
      randomUUID(),
    );
    expect(reset.revision).toBe(3);

    const audit = await client<{ before_state: { revision: number }; after_state: { revision: number } }[]>`
      SELECT before_state,after_state FROM audit_events
      WHERE target_id=${competition.id} AND action='sport_settings.updated' ORDER BY occurred_at,id`;
    expect(audit.map((row) => [row.before_state.revision, row.after_state.revision])).toEqual([
      [1, 2],
      [2, 3],
    ]);

    const history = await federationRuntime.settingsHistory(actor, competition.id);
    expect(history).toHaveLength(2);
    expect(history.every((item) => item.actor_name === "Owner")).toBe(true);
    const changes = history.map((item) => item.changes);
    expect(changes).toContainEqual([{ setting: "periodDurationMinutes", before: 10, after: 7 }]);
    expect(changes).toContainEqual([{ setting: "periodDurationMinutes", before: 7, after: 10 }]);
  });
});

describeInfrastructure("Who can change rules (D23)", () => {
  it("lets only owners and organisers write rules; everyone else gets 403", async () => {
    const competition = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const division = (await federationRuntime.createDivision(
      { accountId: ownerId },
      competition.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      `division-${randomUUID()}`,
    )) as { id: string };
    const organiserId = await account(`organiser-${randomUUID()}@rules.test`);
    const viewerId = await account(`viewer-${randomUUID()}@rules.test`);
    const officialId = await account(`official-${randomUUID()}@rules.test`);
    await client`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES
      (${organisationId},${organiserId},'organiser','active'),
      (${organisationId},${viewerId},'viewer','active')`;
    await client`INSERT INTO official_grants (account_id,organisation_id,resource_type,resource_id,granted_by)
      VALUES (${officialId},${organisationId},'competition',${competition.id},${ownerId})`;
    const sessions: Record<string, string> = {
      "owner-token": ownerId,
      "organiser-token": organiserId,
      "viewer-token": viewerId,
      "official-token": officialId,
    };
    const identityRuntime = {
      authenticate: vi.fn(async (token: string) => {
        const id = sessions[token];
        if (!id) throw new ApiError(401, ErrorCode.AUTHENTICATION_REQUIRED, "Authentication required");
        return {
          account: {
            id,
            primaryEmail: `${token}@rules.test`,
            displayName: token,
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: "csrf-ok",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }),
      verifyCsrfToken: vi.fn((_token: string, csrf: string) => csrf === "csrf-ok"),
    } as unknown as IdentityApiRuntime;
    const sql = client as unknown as PostgresJsSql;
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime,
      phase2Runtime: new Phase2Runtime(
        sql,
        phase2DomainAdapter,
        undefined,
        undefined,
        "redesign-p4-rules-fallback-code-hmac-secret",
      ),
      phase3Runtime: federationRuntime,
    });
    apps.push(app);

    const callers: Record<string, string | null> = {
      owner: "matchday_session=owner-token",
      organiser: "matchday_session=organiser-token",
      viewer: "matchday_session=viewer-token",
      official: "matchday_session=official-token",
      captainMagicLink: "matchday_captain=magic-link-token",
      anonymous: null,
    };
    const revisions = { competition: 1, division: 1 };
    const routes = [
      {
        name: "competition rules",
        method: "PUT" as const,
        url: () => `/api/v1/competitions/${competition.id}/settings`,
        payload: () => ({ pack_version: "1.0.0", revision: revisions.competition, override: {} }),
        onSuccess: () => (revisions.competition += 1),
      },
      {
        name: "division rules",
        method: "PUT" as const,
        url: () => `/api/v1/competitions/${competition.id}/divisions/${division.id}/settings`,
        payload: () => ({ pack_version: "1.0.0", revision: revisions.division, override: {} }),
        onSuccess: () => (revisions.division += 1),
      },
      {
        name: "legacy canoe polo settings",
        method: "PUT" as const,
        url: () => `/api/v1/competitions/${competition.id}/canoe-polo-settings`,
        payload: () => ({ periodMinutes: 10 }),
        onSuccess: () => undefined,
      },
    ];
    const outcomes: Record<string, Record<string, number>> = {};
    for (const route of routes) {
      outcomes[route.name] = {};
      for (const [caller, cookie] of Object.entries(callers)) {
        const response = await app.inject({
          method: route.method,
          url: route.url(),
          headers: {
            origin: "http://localhost:3000",
            "x-csrf-token": "csrf-ok",
            ...(cookie ? { cookie } : {}),
          },
          payload: route.payload(),
        });
        outcomes[route.name]![caller] = response.statusCode;
        if (response.statusCode === 200) route.onSuccess();
      }
    }
    const expected = {
      owner: 200,
      organiser: 200,
      viewer: 403,
      official: 403,
      captainMagicLink: 403,
      anonymous: 403,
    };
    expect(outcomes).toEqual(Object.fromEntries(routes.map((route) => [route.name, expected])));

    // Copy-previous follows the same rule; without a previous competition the owners get 404, the rest 403.
    for (const [caller, cookie] of Object.entries(callers)) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/competitions/${competition.id}/settings/copy-previous`,
        headers: { origin: "http://localhost:3000", "x-csrf-token": "csrf-ok", ...(cookie ? { cookie } : {}) },
      });
      expect([caller, response.statusCode]).toEqual([caller, caller === "owner" || caller === "organiser" ? 404 : 403]);
    }

    // Reading the rules and their history stays open to viewers (the page is read-only for them).
    const viewerHistory = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${competition.id}/settings/history`,
      headers: { cookie: callers.viewer! },
    });
    expect(viewerHistory.statusCode).toBe(200);
    expect(viewerHistory.json().items.length).toBeGreaterThanOrEqual(2);
  });
});
