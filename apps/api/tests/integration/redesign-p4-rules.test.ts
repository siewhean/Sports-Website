import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import * as domainModule from "@matchday/domain";
import { createRoundRobinFormatGraph, DRAFT_SPORT_PACK_VERSION } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../../src/app.js";
import { ApiError, ErrorCode } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { GateBPhase4Runtime } from "../../src/phase-4-gate-b-runtime.js";
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
}, 60_000);

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
}, 60_000);

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
    let compRevision = 1;
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
      {
        name: "pack switch via PATCH phase3",
        method: "PATCH" as const,
        url: () => `/api/v1/competitions/${competition.id}/phase3`,
        payload: () => ({ revision: compRevision, confirm_pack_switch: false }),
        onSuccess: () => (compRevision += 1),
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

    // Update-defaults follows D23: owners and organisers get 200, everyone else gets 403.
    for (const [caller, cookie] of Object.entries(callers)) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/competitions/${competition.id}/settings/update-defaults`,
        headers: { origin: "http://localhost:3000", "x-csrf-token": "csrf-ok", ...(cookie ? { cookie } : {}) },
      });
      expect([caller, response.statusCode]).toEqual([caller, caller === "owner" || caller === "organiser" ? 200 : 403]);
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

describeInfrastructure("Start-date re-offer (Section A)", () => {
  it("offers pack switch when draft badminton start date crosses 4 Jan 2027", async () => {
    const comp = await create(federationRuntime, "badminton", "2027-01-03");
    expect(await packVersion(comp.id)).toBe("1.0.0");
    const actor = { accountId: ownerId };

    // Set an override to verify lost overrides reporting
    await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 1, override: { bestOf: 5 } },
      randomUUID(),
    );

    // Editing startsOn across Jan 4 without confirm_pack_switch returns 409 SPORT_PACK_UPDATE_OFFERED
    await expect(
      federationRuntime.mutateCompetition(
        actor,
        comp.id,
        {
          action: "update",
          revision: 1,
          patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.SPORT_PACK_UPDATE_OFFERED,
      details: {
        current_pack_version: "1.0.0",
        offered_pack_version: "1.1.0",
        lost_overrides: {
          competition: { bestOf: 5 },
          divisions: [],
        },
      },
    });

    // Stale revision gives REVISION_CONFLICT, not the re-offer
    await expect(
      federationRuntime.mutateCompetition(
        actor,
        comp.id,
        {
          action: "update",
          revision: 999,
          patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.REVISION_CONFLICT,
    });

    // Keeping current pack (confirm_pack_switch: false) saves date and preserves pack 1.0.0 and overrides
    const kept = await federationRuntime.mutateCompetition(
      actor,
      comp.id,
      {
        action: "update",
        revision: 1,
        confirm_pack_switch: false,
        patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
      },
      randomUUID(),
    );
    expect(kept.revision).toBe(2);
    expect(await packVersion(comp.id)).toBe("1.0.0");
    const settingsAfterKeep = await federationRuntime.readSettings(actor, comp.id);
    expect(settingsAfterKeep.override).toEqual({ bestOf: 5 });

    // Confirming pack switch (confirm_pack_switch: true) switches pack to 1.1.0 and resets overrides
    const switched = await federationRuntime.mutateCompetition(
      actor,
      comp.id,
      {
        action: "update",
        revision: 2,
        confirm_pack_switch: true,
        patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
      },
      randomUUID(),
    );
    expect(switched.revision).toBe(3);
    expect(await packVersion(comp.id)).toBe("1.1.0");
    const settingsAfterSwitch = await federationRuntime.readSettings(actor, comp.id);
    expect(settingsAfterSwitch.override).toEqual({});

    // History includes sport_settings.pack_switched
    const history = await federationRuntime.settingsHistory(actor, comp.id);
    expect(history.some((h) => h.action === "sport_settings.pack_switched")).toBe(true);

    // Competition in 'ready' status also offers pack switch on date edit crossing Jan 4
    const readyComp = await create(federationRuntime, "badminton", "2027-01-03");
    await federationRuntime.createDivision(
      actor,
      readyComp.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      `div-${randomUUID()}`,
    );
    await client`UPDATE competitions SET status='ready' WHERE id=${readyComp.id}`;
    await expect(
      federationRuntime.mutateCompetition(
        actor,
        readyComp.id,
        {
          action: "update",
          revision: 1,
          patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.SPORT_PACK_UPDATE_OFFERED,
    });
  });

  it("does not offer a switch when competition is on a draft pack", async () => {
    const comp = await create(draftRuntime, "badminton", "2027-01-03");
    expect(await packVersion(comp.id)).toBe(DRAFT_SPORT_PACK_VERSION);
    const actor = { accountId: ownerId };

    // Crossing Jan 4 gets 200 without re-offer
    const updated = await draftRuntime.mutateCompetition(
      actor,
      comp.id,
      {
        action: "update",
        revision: 1,
        patch: { startsOn: "2027-01-04", endsOn: "2027-01-04" },
      },
      randomUUID(),
    );
    expect(updated.revision).toBe(2);
    expect(await packVersion(comp.id)).toBe(DRAFT_SPORT_PACK_VERSION);
  });
});

describeInfrastructure("Results-exist confirmation guard & recalculation (Section B)", () => {
  it("requires confirmation when scoring rules change and results exist", async () => {
    const comp = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const actor = { accountId: ownerId };
    const div1 = (await federationRuntime.createDivision(
      actor,
      comp.id,
      { name: "Div 1", entryLimit: 8 },
      randomUUID(),
      `div1-${randomUUID()}`,
    )) as { id: string };
    const div2 = (await federationRuntime.createDivision(
      actor,
      comp.id,
      { name: "Div 2", entryLimit: 8 },
      randomUUID(),
      `div2-${randomUUID()}`,
    )) as { id: string };

    const homeId = randomUUID();
    const awayId = randomUUID();
    await client`INSERT INTO division_entries(id, division_id, name, seed, entry_type, status)
      VALUES (${homeId}, ${div1.id}, 'Team 1', 1, 'team', 'confirmed'),
             (${awayId}, ${div1.id}, 'Team 2', 2, 'team', 'confirmed')`;

    await federationRuntime.replaceCapacity(
      actor,
      comp.id,
      {
        revision: 1,
        areas: [
          {
            name: "Pitch 1",
            slotMinutes: 40,
            availability: [{ date: "2027-03-01", startTime: "08:00", endTime: "20:00" }],
          },
        ],
      },
      randomUUID(),
    );

    const graph = createRoundRobinFormatGraph(2);
    const format = await federationRuntime.createFormatRevision(actor, comp.id, div1.id, graph, randomUUID());

    const matchId = randomUUID();
    const matchCode = graph.matches[0]!.id;
    await client`INSERT INTO matches(
      id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal, home_entry_id, away_entry_id, state
    ) VALUES (
      ${matchId}, ${comp.id}, ${div1.id}, ${format.id}, ${matchCode}, 'group', 1, 1, ${homeId}, ${awayId}, 'final'
    )`;

    await federationRuntime.publishFormat(actor, comp.id, format.id, format.definition_hash, randomUUID());

    await client`INSERT INTO match_result_snapshots(
      match_id, result_version, through_sequence, home_score, away_score, state, snapshot
    ) VALUES (
      ${matchId}, 1, 1, 2, 0, 'final', ${client.json({ homeSegments: [2], awaySegments: [0] })}
    )`;

    await client`INSERT INTO competition_publications (competition_id, result_version)
      VALUES (${comp.id}, 1)
      ON CONFLICT (competition_id) DO UPDATE SET result_version = 1`;

    const initialStandings = (await federationRuntime.recalculateStandings(actor, comp.id, div1.id, randomUUID())) as {
      result_version: number;
    };
    expect(initialStandings.result_version).toBe(1);

    // Changing non-scoring rule (e.g. shotClockSeconds) does NOT require confirmation
    const nonScoring = await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 1, override: { shotClockSeconds: 45 } },
      randomUUID(),
    );
    expect(nonScoring.revision).toBe(2);

    // Changing scoring rule (e.g. winPoints) WITHOUT confirmation fails with 409 RESULTS_EXIST_CONFIRMATION_REQUIRED
    await expect(
      federationRuntime.updateSettings(
        actor,
        comp.id,
        { packVersion: "1.0.0", revision: 2, override: { winPoints: 4 } },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.RESULTS_EXIST_CONFIRMATION_REQUIRED,
      details: {
        affected_match_count: 1,
        affected_matches: [{ id: matchId, division_id: div1.id, status: "final" }],
      },
    });

    // Updating Division 2 (which has no matches) does NOT require confirmation even for scoring rules
    const div2Update = await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 1, divisionId: div2.id, override: { winPoints: 4 } },
      randomUUID(),
    );
    expect(div2Update.revision).toBe(2);

    // Changing scoring rule with confirmResultsAffected: true succeeds, bumps publication result_version, and recalculates
    const confirmed = await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 2, override: { winPoints: 4 }, confirmResultsAffected: true },
      randomUUID(),
    );
    expect(confirmed.revision).toBe(3);

    // Verify publication result_version was bumped and results_published_at was set
    const [pub] = await client<{ result_version: number; results_published_at: Date | null }[]>`
      SELECT result_version, results_published_at FROM competition_publications WHERE competition_id=${comp.id}`;
    expect(pub?.result_version).toBe(2);
    expect(pub?.results_published_at).not.toBeNull();

    // Standings are readable after confirm with result_version 2 (recalculated with new rules, no STANDINGS_SOURCE_STALE)
    const standings = (await federationRuntime.readStandings(actor, comp.id, div1.id)) as unknown as {
      result_version: number;
      standings: { groups: Record<string, { rows: { entryId: string; tablePoints: number }[] }> };
    };
    expect(standings.result_version).toBe(2);
    expect(standings.standings).toBeDefined();
    const groupRows = Object.values(standings.standings.groups)[0]?.rows;
    const winnerRow = groupRows?.find((r) => r.entryId === homeId);
    expect(winnerRow?.tablePoints).toBe(4);

    // Verify bracket_snapshots was updated for result_version 2
    const [bracketSnap] = await client<{ result_version: number }[]>`
      SELECT result_version FROM bracket_snapshots WHERE competition_id=${comp.id} AND division_id=${div1.id} AND result_version=2`;
    expect(bracketSnap?.result_version).toBe(2);

    // An explicit recalculation after the confirmed rule change succeeds (no STANDINGS_SOURCE_STALE) and the
    // standings still reflect the new winPoints rule.
    await expect(federationRuntime.recalculateStandings(actor, comp.id, div1.id, randomUUID())).resolves.toBeDefined();
    const recalculated = (await federationRuntime.readStandings(actor, comp.id, div1.id)) as unknown as {
      result_version: number;
      standings: { groups: Record<string, { rows: { entryId: string; tablePoints: number }[] }> };
    };
    expect(recalculated.result_version).toBe(2);
    const recalculatedWinner = Object.values(recalculated.standings.groups)[0]?.rows.find((r) => r.entryId === homeId);
    expect(recalculatedWinner?.tablePoints).toBe(4);

    // Verify match state and event/result scores were untouched
    const [match] = await client<{ state: string }[]>`SELECT state FROM matches WHERE id=${matchId}`;
    expect(match?.state).toBe("final");
    const [resultSnapshot] = await client<{ home_score: number; away_score: number }[]>`
      SELECT home_score, away_score FROM match_result_snapshots WHERE match_id=${matchId}`;
    expect(resultSnapshot?.home_score).toBe(2);
    expect(resultSnapshot?.away_score).toBe(0);
  });

  it("refreshes public standings and bracket snapshots on published competitions after rule changes", async () => {
    const comp = await create(federationRuntime, "canoe_polo", "2027-03-01");
    const actor = { accountId: ownerId };
    const div = (await federationRuntime.createDivision(
      actor,
      comp.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      `div-open-${randomUUID()}`,
    )) as { id: string };

    const t1 = randomUUID();
    const t2 = randomUUID();
    await client`INSERT INTO division_entries(id, division_id, name, seed, entry_type, status)
      VALUES (${t1}, ${div.id}, 'Team Alpha', 1, 'team', 'confirmed'),
             (${t2}, ${div.id}, 'Team Beta', 2, 'team', 'confirmed')`;

    await federationRuntime.replaceCapacity(
      actor,
      comp.id,
      {
        revision: 1,
        areas: [
          {
            name: "Pitch 1",
            slotMinutes: 40,
            availability: [{ date: "2027-03-01", startTime: "08:00", endTime: "20:00" }],
          },
        ],
      },
      randomUUID(),
    );

    const graph = createRoundRobinFormatGraph(2);
    const format = await federationRuntime.createFormatRevision(actor, comp.id, div.id, graph, randomUUID());

    const matchId = randomUUID();
    const matchCode = graph.matches[0]!.id;
    await client`INSERT INTO matches(
      id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal, home_entry_id, away_entry_id, state
    ) VALUES (
      ${matchId}, ${comp.id}, ${div.id}, ${format.id}, ${matchCode}, 'group', 1, 1, ${t1}, ${t2}, 'final'
    )`;

    await federationRuntime.publishFormat(actor, comp.id, format.id, format.definition_hash, randomUUID());

    await client`INSERT INTO match_result_snapshots(
      match_id, result_version, through_sequence, home_score, away_score, state, snapshot
    ) VALUES (
      ${matchId}, 1, 1, 3, 1, 'final', ${client.json({ homeSegments: [3], awaySegments: [1] })}
    )`;

    // Set competition to published with publication at result_version 1
    await client`UPDATE competitions SET status='ready' WHERE id=${comp.id}`;
    await client`UPDATE competitions SET status='published' WHERE id=${comp.id}`;
    await client`INSERT INTO competition_publications (competition_id, schedule_version, result_version, results_published_at)
      VALUES (${comp.id}, 0, 1, now())
      ON CONFLICT (competition_id) DO UPDATE SET schedule_version = 0, result_version = 1, results_published_at = now()`;

    // Initial recalculation & projection write at result_version 1
    await federationRuntime.recalculateStandings(actor, comp.id, div.id, randomUUID());
    const phase2 = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      undefined,
      undefined,
      "redesign-p4-rules-fallback-code-hmac-secret",
    );
    federationRuntime.setPublicProjection(phase2);
    await phase2.writePublicProjection(client as unknown as PostgresJsSql, comp.id, 0, 1);

    // Initial public projection at result_version 1
    const [initialProj] = await client<{ result_version: number; projection: unknown }[]>`
      SELECT result_version, projection FROM public_competition_projections WHERE competition_id=${comp.id}`;
    expect(initialProj?.result_version).toBe(1);

    // Now change winPoints to 5 with confirmResultsAffected: true
    await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 1, override: { winPoints: 5 }, confirmResultsAffected: true },
      randomUUID(),
    );

    // Verify publication result_version bumped to 2 and results_published_at updated
    const [pub] = await client<{ result_version: number; results_published_at: Date | null }[]>`
      SELECT result_version, results_published_at FROM competition_publications WHERE competition_id=${comp.id}`;
    expect(pub?.result_version).toBe(2);
    expect(pub?.results_published_at).not.toBeNull();

    // Verify bracket_snapshots exists at result_version 2
    const [bracketSnap] = await client<{ result_version: number }[]>`
      SELECT result_version FROM bracket_snapshots WHERE competition_id=${comp.id} AND division_id=${div.id} AND result_version=2`;
    expect(bracketSnap?.result_version).toBe(2);

    // Verify public_competition_projections is automatically refreshed at result_version 2
    const [refreshedProj] = await client<{ result_version: number; projection: unknown }[]>`
      SELECT result_version, projection FROM public_competition_projections
      WHERE competition_id=${comp.id} AND result_version=2`;
    expect(refreshedProj?.result_version).toBe(2);

    // Spectators see the updated standings (winner points = 5) in the refreshed public projection
    const rawProj =
      typeof refreshedProj?.projection === "string"
        ? (JSON.parse(refreshedProj.projection) as Record<string, unknown>)
        : (refreshedProj?.projection as Record<string, unknown> | undefined);
    const proj = rawProj as {
      divisions?: Array<{
        standings?: {
          standings?: {
            groups?: Record<string, { rows?: Array<{ entryId: string; tablePoints: number }> }>;
          };
        };
      }>;
    };
    const publicStandings = proj?.divisions?.[0]?.standings?.standings;
    const firstGroup = publicStandings?.groups ? Object.values(publicStandings.groups)[0] : undefined;
    const winnerRow = firstGroup?.rows?.find((r) => r.entryId === t1);
    expect(winnerRow?.tablePoints).toBe(5);
  });
});

describeInfrastructure("Update to latest federation defaults (Section C)", () => {
  it("resets overrides to federation defaults and enforces status rules", async () => {
    const comp = await create(federationRuntime, "badminton", "2027-01-03");
    expect(await packVersion(comp.id)).toBe("1.0.0");
    const actor = { accountId: ownerId };

    // Set an override
    await federationRuntime.updateSettings(
      actor,
      comp.id,
      { packVersion: "1.0.0", revision: 1, override: { bestOf: 5 } },
      randomUUID(),
    );

    // Update defaults in draft: succeeds freely and resets override
    const updated = await federationRuntime.updateToFederationDefaults(actor, comp.id, undefined, randomUUID());
    expect(updated.override).toEqual({});
    expect(updated.revision).toBe(3);

    // One action, one history row: a single sport_settings.defaults_updated event (no separate pack_switched)
    // carrying the before/after pack versions.
    const defaultsEvents = await client<{ action: string; after_state: Record<string, unknown> }[]>`
      SELECT action, after_state FROM audit_events
      WHERE target_type='competition' AND target_id=${comp.id}
        AND action IN ('sport_settings.defaults_updated','sport_settings.pack_switched')`;
    expect(defaultsEvents).toHaveLength(1);
    expect(defaultsEvents[0]?.action).toBe("sport_settings.defaults_updated");
    const defaultsState =
      typeof defaultsEvents[0]?.after_state === "string"
        ? (JSON.parse(defaultsEvents[0].after_state) as Record<string, unknown>)
        : defaultsEvents[0]?.after_state;
    expect(defaultsState).toMatchObject({ previous_pack_version: "1.0.0", pack_version: expect.any(String) });
    const defaultsHistory = await federationRuntime.settingsHistory(actor, comp.id);
    expect(defaultsHistory.filter((h) => h.action === "sport_settings.defaults_updated")).toHaveLength(1);
    expect(defaultsHistory.some((h) => h.action === "sport_settings.pack_switched")).toBe(false);

    // Calling again when already on latest with zero overrides is a no-op
    const noop = await federationRuntime.updateToFederationDefaults(actor, comp.id, undefined, randomUUID());
    expect(noop.revision).toBe(3);

    // Transition to ready: updating defaults succeeds without confirmPublished
    await federationRuntime.createDivision(
      actor,
      comp.id,
      { name: "Open", entryLimit: 8 },
      randomUUID(),
      `div-${randomUUID()}`,
    );
    await client`UPDATE competitions SET status='ready' WHERE id=${comp.id}`;
    await client`UPDATE competition_sport_settings SET settings_override='{"bestOf":5}'::jsonb WHERE competition_id=${comp.id}`;
    const readyUpdated = await federationRuntime.updateToFederationDefaults(actor, comp.id, undefined, randomUUID());
    expect(readyUpdated.override).toEqual({});

    // Transition to published: updating defaults requires confirmation
    await client`UPDATE competitions SET status='published' WHERE id=${comp.id}`;

    // Without confirmPublished: throws 409 PUBLISHED_COMPETITION_CONFIRMATION_REQUIRED
    // (first set an override so it is not a no-op)
    await client`UPDATE competition_sport_settings SET settings_override='{"bestOf":5}'::jsonb WHERE competition_id=${comp.id}`;

    await expect(
      federationRuntime.updateToFederationDefaults(actor, comp.id, undefined, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.PUBLISHED_COMPETITION_CONFIRMATION_REQUIRED,
    });

    // With confirmPublished: true: succeeds
    const confirmedPub = await federationRuntime.updateToFederationDefaults(
      actor,
      comp.id,
      { confirmPublished: true },
      randomUUID(),
    );
    expect(confirmedPub.override).toEqual({});

    // Flag disabled: throws 404 ROUTE_NOT_FOUND
    await expect(
      draftRuntime.updateToFederationDefaults(actor, comp.id, { confirmPublished: true }, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: ErrorCode.ROUTE_NOT_FOUND,
    });

    // Sport with no federation pack: throws 400 REQUEST_INVALID
    const packSpy = vi.spyOn(domainModule, "federationSportPackFor").mockImplementationOnce(() => {
      throw new Error("No federation sport pack available");
    });
    await expect(
      federationRuntime.updateToFederationDefaults(actor, comp.id, { confirmPublished: true }, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCode.REQUEST_INVALID,
    });
    packSpy.mockRestore();

    // Refused for completed and archived competitions
    await client`UPDATE competitions SET status='live' WHERE id=${comp.id}`;
    await client`UPDATE competitions SET status='completed' WHERE id=${comp.id}`;
    await expect(
      federationRuntime.updateToFederationDefaults(actor, comp.id, { confirmPublished: true }, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    await client`UPDATE competitions SET status='archived', archived_from_status='completed' WHERE id=${comp.id}`;
    await expect(
      federationRuntime.updateToFederationDefaults(actor, comp.id, { confirmPublished: true }, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.COMPETITION_ARCHIVED,
    });
  });
});

describeInfrastructure("Assisted Setup date change re-offer and pack switch (Gate B)", () => {
  it("offers pack switch on date change in patchSetupDraft and autosaveSetupDraft, and applies decision", async () => {
    const gateB = new GateBPhase4Runtime(
      client as unknown as PostgresJsSql,
      federationRuntime,
      { enqueueSchedule: async () => ({ id: "ignored", name: "schedule.optimize", duplicate: false }) },
      {
        mode: "stub",
        provider: { generate: async () => ({ text: "", refusal: null, usage: {} }) } as never,
        timeoutMs: 2_000,
        maximumAttempts: 1,
        cacheTtlSeconds: 3_600,
      },
    );

    const comp = await create(federationRuntime, "badminton", "2027-01-03");
    expect(await packVersion(comp.id)).toBe("1.0.0");
    const actor = { accountId: ownerId };

    const fixtureDivisionId = randomUUID();
    await client`INSERT INTO divisions(id,competition_id,name,team_limit)
      VALUES(${fixtureDivisionId},${comp.id},'Open',16)`;
    for (let seed = 1; seed <= 8; seed += 1) {
      await client`INSERT INTO division_entries(id,division_id,name,seed,status)
        VALUES(${randomUUID()},${fixtureDivisionId},${`Entry ${seed}`},${seed},'confirmed')`;
    }

    await client`INSERT INTO setup_drafts(organisation_id, competition_id, created_by, updated_by)
      VALUES(${organisationId}, ${comp.id}, ${ownerId}, ${ownerId})`;

    const draft = await gateB.readSetupDraft(actor, comp.id);
    expect(draft.values.basics?.starts_on).toBe("2027-01-03");

    const newBasics = {
      ...draft.values.basics!,
      starts_on: "2027-01-04",
      ends_on: "2027-01-04",
    };

    // 1. patchSetupDraft without confirm_pack_switch throws 409 SPORT_PACK_UPDATE_OFFERED
    await expect(
      gateB.patchSetupDraft(
        actor,
        comp.id,
        {
          expected_revision: draft.revision,
          idempotency_key: randomUUID(),
          step: { step_id: "basics", value: newBasics },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.SPORT_PACK_UPDATE_OFFERED,
      details: {
        current_pack_version: "1.0.0",
        offered_pack_version: "1.1.0",
      },
    });

    // 2. patchSetupDraft with confirm_pack_switch: false keeps pack at 1.0.0
    const kept = await gateB.patchSetupDraft(
      actor,
      comp.id,
      {
        expected_revision: draft.revision,
        idempotency_key: randomUUID(),
        step: { step_id: "basics", value: newBasics },
        confirm_pack_switch: false,
      },
      randomUUID(),
    );
    expect(kept.outcome).toBe("saved");
    expect(await packVersion(comp.id)).toBe("1.0.0");
    const draftKept = await gateB.readSetupDraft(actor, comp.id);
    expect(draftKept.values.basics?.starts_on).toBe("2027-01-04");

    // 3. patchSetupDraft with confirm_pack_switch: true switches pack to 1.1.0
    const switched = await gateB.patchSetupDraft(
      actor,
      comp.id,
      {
        expected_revision: draftKept.revision,
        idempotency_key: randomUUID(),
        step: { step_id: "basics", value: newBasics },
        confirm_pack_switch: true,
      },
      randomUUID(),
    );
    expect(switched.outcome).toBe("saved");
    expect(await packVersion(comp.id)).toBe("1.1.0");
    const draftSwitched = await gateB.readSetupDraft(actor, comp.id);
    expect(draftSwitched.values.basics?.starts_on).toBe("2027-01-04");

    // 4. autosaveSetupDraft without confirm_pack_switch throws 409 SPORT_PACK_UPDATE_OFFERED
    const backBasics = {
      ...draftSwitched.values.basics!,
      starts_on: "2027-01-03",
      ends_on: "2027-01-03",
    };
    await expect(
      gateB.autosaveSetupDraft(
        actor,
        comp.id,
        {
          expected_revision: draftSwitched.revision,
          idempotency_key: randomUUID(),
          transition: {
            kind: "save_step",
            step: { step_id: "basics", value: backBasics },
          },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.SPORT_PACK_UPDATE_OFFERED,
      details: {
        current_pack_version: "1.1.0",
        offered_pack_version: "1.0.0",
      },
    });

    // 5. autosaveSetupDraft with confirm_pack_switch: true switches back to 1.0.0
    const autoSaved = await gateB.autosaveSetupDraft(
      actor,
      comp.id,
      {
        expected_revision: draftSwitched.revision,
        idempotency_key: randomUUID(),
        transition: {
          kind: "save_step",
          step: { step_id: "basics", value: backBasics },
        },
        confirm_pack_switch: true,
      },
      randomUUID(),
    );
    expect(autoSaved.outcome).toBe("saved");
    expect(await packVersion(comp.id)).toBe("1.0.0");
  });
});
