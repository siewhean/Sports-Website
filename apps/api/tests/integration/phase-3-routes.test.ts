import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { ApiError } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import type { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function identityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => ({
      account: {
        id: randomUUID(),
        primaryEmail: "phase3@example.test",
        displayName: "Phase 3",
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
    })),
    verifyCsrfToken: vi.fn((_token: string, csrf: string) => csrf === "csrf-ok"),
  } as unknown as IdentityApiRuntime;
}

function runtime() {
  return {
    listWritableOrganisations: vi.fn(async () => [
      { id: randomUUID(), name: "Phase 3 Organisation", role: "owner" as const },
    ]),
    listOrganiserCompetitions: vi.fn(async () => [
      {
        id: randomUUID(),
        name: "Phase 3 Cup",
        slug: "phase-3-cup",
        sport_code: "badminton" as const,
        status: "draft",
        starts_on: "2027-01-01",
        ends_on: "2027-01-02",
        organisation_name: "Phase 3 Organisation",
        membership_role: "owner" as const,
      },
    ]),
    readCompetition: vi.fn(async (_actor, id: string) => ({ id, sport_code: "badminton", revision: 1 })),
    createCompetition: vi.fn(async () => ({ id: randomUUID(), sport_code: "badminton", status: "draft", revision: 1 })),
    mutateCompetition: vi.fn(async () => ({ revision: 2 })),
    transitionCompetition: vi.fn(async () => ({ revision: 2 })),
    deleteCompetition: vi.fn(async () => ({ deleted: true })),
    duplicateCompetition: vi.fn(async () => ({ id: randomUUID(), status: "draft" })),
    listDivisions: vi.fn(async () => []),
    createDivision: vi.fn(async () => ({ id: randomUUID(), revision: 1 })),
    updateDivision: vi.fn(async () => ({ revision: 2 })),
    deleteDivision: vi.fn(async () => ({ deleted: true })),
    listEntries: vi.fn(async () => []),
    mutateEntry: vi.fn(async () => ({ id: randomUUID(), status: "active" })),
    updateEntry: vi.fn(async () => ({ revision: 2 })),
    deleteEntry: vi.fn(async () => ({ deleted: true })),
    importEntries: vi.fn(async () => ({ ok: true, import_id: randomUUID(), inserted: 1, entries: [] })),
    rollbackEntryImport: vi.fn(async () => ({ rolled_back: true, idempotent_replay: false, removed: 1 })),
    readSettings: vi.fn(async (_actor, competitionId: string, divisionId?: string) => ({
      competition_id: competitionId,
      division_id: divisionId ?? null,
      sport_code: "badminton",
      pack_version: "0.1.0-draft.1",
      pack_schema_version: 1,
      pack_definition_hash: "a".repeat(64),
      pack_definition: {},
      recommended_snapshot: {},
      competition_override: {},
      override: {},
      revision: 1,
      effective: {},
      mode: "recommended",
      permission: "write",
      read_only: false,
      organisation_id: randomUUID(),
    })),
    updateSettings: vi.fn(async () => ({ revision: 2 })),
    copyPreviousSettings: vi.fn(async () => ({ revision: 2 })),
    readAccountDefault: vi.fn(async () => ({ settings: null })),
    saveAccountDefault: vi.fn(async () => ({ settings: {} })),
    deleteAccountDefault: vi.fn(async () => ({ deleted: true })),
    readSportPackAdmin: vi.fn(async (_actor, sportCode: string, version: string) => ({
      sport_code: sportCode,
      version,
      schema_version: 1,
      definition: {},
      definition_hash: "a".repeat(64),
      status: "draft",
      revision: 1,
      created_by: randomUUID(),
      created_at: new Date().toISOString(),
      activated_by: null,
      activated_at: null,
      superseded_at: null,
      superseded_by: null,
      superseded_by_version: null,
      read_only: true,
    })),
    listSportPackAdmin: vi.fn(async (_actor, sportCode: string) => ({
      sport_code: sportCode,
      active_version: null,
      versions: [],
    })),
    createSportPackDraft: vi.fn(async () => ({
      sport_code: "badminton",
      version: "test-v1",
      schema_version: 1,
      definition_hash: "a".repeat(64),
      status: "draft",
      revision: 1,
      created_by: randomUUID(),
      created_at: new Date().toISOString(),
      idempotent_replay: false,
    })),
    activateSportPack: vi.fn(async () => ({
      sport_code: "badminton",
      version: "test-v1",
      schema_version: 1,
      definition_hash: "a".repeat(64),
      status: "active",
      revision: 2,
      activated_by: randomUUID(),
      activated_at: new Date().toISOString(),
      previous_active_version: null,
      idempotent_replay: false,
    })),
    capacity: vi.fn(async (_actor, competitionId: string) => ({
      competition_id: competitionId,
      revision: 1,
      timezone: "Asia/Singapore",
      permission: "write",
      read_only: false,
      areas: [],
      effective: {
        timeZone: "Asia/Singapore",
        slotMinutes: 30,
        rawTotalSlots: 0,
        fixedReserveSlots: 0,
        availableMatchSlots: 0,
        requiredMatchSlots: 0,
        remainingMatchSlots: 0,
        status: "comfortable",
        intervals: [],
        areas: [],
      },
    })),
    replaceCapacity: vi.fn(async (_actor, competitionId: string) => ({
      competition_id: competitionId,
      revision: 2,
      timezone: "Asia/Singapore",
      permission: "write",
      read_only: false,
      areas: [],
      effective: {
        timeZone: "Asia/Singapore",
        slotMinutes: 30,
        rawTotalSlots: 0,
        fixedReserveSlots: 0,
        availableMatchSlots: 0,
        requiredMatchSlots: 0,
        remainingMatchSlots: 0,
        status: "comfortable",
        intervals: [],
        areas: [],
      },
      idempotent_replay: false,
    })),
    createFormatRevision: vi.fn(async () => ({ id: randomUUID(), valid: true })),
    publishFormat: vi.fn(async () => ({ status: "published" })),
    recalculateStandings: vi.fn(async () => ({ id: randomUUID(), result_version: 1 })),
    readStandings: vi.fn(async (_actor, competitionId: string, divisionId: string) => ({
      id: randomUUID(),
      competition_id: competitionId,
      division_id: divisionId,
      result_version: 1,
      standings: {},
      explanation: {},
      calculation_input_hash: "a".repeat(64),
      source_result_hash: "b".repeat(64),
      settings_version: "settings-v1",
      snapshot_fingerprint: "c".repeat(64),
      created_at: new Date().toISOString(),
      advancement_slots: [],
      advancement_conflicts: [],
    })),
  } as unknown as Phase3Runtime;
}

function validFormatGraph() {
  return {
    id: "two-entry-final",
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
        matchIds: ["final"],
      },
    ],
    matches: [
      {
        id: "final",
        stageId: "final-stage",
        round: 1,
        order: 1,
        purpose: "championship",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 2 },
      },
    ],
    terminalMatchIds: ["final"],
  };
}

describe("Phase 3 authenticated route boundary", () => {
  it("returns only the runtime's authenticated writable organisation options", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/organisations/competition-options",
      headers: { cookie: "matchday_session=session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({ name: "Phase 3 Organisation", role: "owner" })]);
    expect(phase3Runtime.listWritableOrganisations).toHaveBeenCalledOnce();
  });

  it("lists only competitions accessible to the authenticated organiser", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/competitions",
      headers: { cookie: "matchday_session=session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ name: "Phase 3 Cup", membership_role: "owner", sport_code: "badminton" }),
    ]);
    expect(phase3Runtime.listOrganiserCompetitions).toHaveBeenCalledOnce();
  });

  it("requires same-origin and CSRF for mutations and permits authenticated reads", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const competitionId = randomUUID();
    const payload = {
      organisation_id: randomUUID(),
      name: "Cup",
      slug: "cup",
      sport_code: "badminton",
      venue: "Hall",
      address: "1 Road",
      country_code: "SG",
      starts_on: "2027-01-01",
      ends_on: "2027-01-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
      idempotency_key: randomUUID(),
    };

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions/phase3",
          headers: { cookie: "matchday_session=session", origin: "https://evil.test", "x-csrf-token": "csrf-ok" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions/phase3",
          headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "wrong" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/competitions/phase3",
          headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(phase3Runtime.createCompetition).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ organisationId: payload.organisation_id, sportCode: "badminton" }),
      expect.any(String),
      payload.idempotency_key,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/competitions/${competitionId}/phase3`,
          headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("preserves optimistic conflicts without success evidence", async () => {
    const phase3Runtime = runtime();
    vi.mocked(phase3Runtime.updateSettings).mockRejectedValueOnce(
      new ApiError(409, "REVISION_CONFLICT", "Sport settings revision is stale"),
    );
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/competitions/${randomUUID()}/settings`,
      headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
      payload: { pack_version: "0.1.0-draft.1", revision: 1, override: {} },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("REVISION_CONFLICT");
  });

  it("exposes exact pinned settings and sport-pack discovery contracts", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const headers = { cookie: "matchday_session=session" };
    const settings = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${randomUUID()}/settings`,
      headers,
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ pack_definition_hash: "a".repeat(64), pack_definition: {} });
    expect(settings.json()).not.toHaveProperty("definition_hash");
    expect(settings.json()).not.toHaveProperty("definition");

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/sport-packs/badminton", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ sport_code: "badminton", active_version: null, versions: [] });

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/admin/sport-packs/badminton/test-v1",
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: "draft",
      superseded_at: null,
      superseded_by: null,
      superseded_by_version: null,
    });
  });

  it("rejects the retired arbitrary standings upload and exposes server-owned recalculate/read contracts", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const headers = {
      cookie: "matchday_session=session",
      origin: "http://127.0.0.1:3000",
      "x-csrf-token": "csrf-ok",
    };
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/standings-snapshots`,
      headers,
      payload: { result_version: 999, standings: { winner: "attacker" }, explanation: {} },
    });
    expect(forged.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/standings/recalculate`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const standings = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/standings`,
      headers: {
        cookie: "matchday_session=session",
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": "csrf-ok",
      },
    });
    expect(standings.statusCode).toBe(200);
    expect(standings.json()).toMatchObject({ result_version: 1, advancement_slots: [], advancement_conflicts: [] });
    expect(phase3Runtime.recalculateStandings).toHaveBeenCalledOnce();
    expect(phase3Runtime.readStandings).toHaveBeenCalledOnce();
  });

  it("wires division, default, and capacity mutations through the shared CSRF boundary", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const headers = { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" };
    const competitionId = randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/competitions/${competitionId}/divisions`,
          headers,
          payload: { name: "Missing key", entry_limit: 8 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/competitions/${competitionId}/divisions`,
          headers,
          payload: { name: "Open", entry_limit: 8, idempotency_key: randomUUID() },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/account/sport-defaults/badminton",
          headers,
          payload: { pack_version: "0.1.0-draft.1", settings: {} },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/competitions/${competitionId}/capacity`,
          headers: { ...headers, "x-csrf-token": "wrong" },
          payload: { revision: 1, areas: [] },
        })
      ).statusCode,
    ).toBe(403);
    expect(phase3Runtime.createDivision).toHaveBeenCalledOnce();
    expect(phase3Runtime.saveAccountDefault).toHaveBeenCalledOnce();
    expect(phase3Runtime.replaceCapacity).not.toHaveBeenCalled();
  });

  it("requires capacity revisions and exposes the platform-admin draft activation routes", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const competitionId = randomUUID();
    const areaId = randomUUID();
    const windowId = randomUUID();
    const headers = {
      cookie: "matchday_session=session",
      origin: "http://127.0.0.1:3000",
      "x-csrf-token": "csrf-ok",
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/competitions/${competitionId}/capacity`,
          headers,
          payload: {
            areas: [
              {
                name: "Legacy court",
                windows: [{ starts_at: "2026-07-20T01:00:00.000Z", ends_at: "2026-07-20T02:00:00.000Z" }],
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(phase3Runtime.replaceCapacity).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/competitions/${competitionId}/capacity`,
          headers,
          payload: {
            revision: 1,
            timezone: "Asia/Singapore",
            areas: [
              {
                id: areaId,
                name: "Court",
                slot_minutes: 30,
                fixed_reserve_slots: 2,
                availability: [{ id: windowId, date: "2027-01-01", start_time: "08:00", end_time: "09:00" }],
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(phase3Runtime.replaceCapacity).toHaveBeenCalledWith(
      expect.anything(),
      competitionId,
      {
        revision: 1,
        timezone: "Asia/Singapore",
        areas: [
          {
            id: areaId,
            name: "Court",
            slotMinutes: 30,
            fixedReserveSlots: 2,
            availability: [{ id: windowId, date: "2027-01-01", startTime: "08:00", endTime: "09:00" }],
          },
        ],
      },
      expect.any(String),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/sport-packs/drafts",
          headers,
          payload: { definition: {} },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/sport-packs/badminton/test-v1/activate",
          headers,
          payload: { revision: 1, expected_active_version: null },
        })
      ).statusCode,
    ).toBe(200);
    expect(phase3Runtime.createSportPackDraft).toHaveBeenCalledOnce();
    expect(phase3Runtime.activateSportPack).toHaveBeenCalledOnce();
  });

  it("passes the complete competition patch and strict entry lifecycle commands", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const headers = {
      cookie: "matchday_session=session",
      origin: "http://127.0.0.1:3000",
      "x-csrf-token": "csrf-ok",
    };
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const entryId = randomUUID();
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/competitions/${competitionId}/phase3`,
      headers,
      payload: {
        revision: 1,
        name: "Updated Cup",
        slug: "updated-cup",
        sport_code: "volleyball",
        venue: "New Hall",
        address: "2 Road",
        locality: null,
        country_code: "SG",
        starts_on: "2027-04-01",
        ends_on: "2027-04-02",
        timezone: "Asia/Singapore",
        locale: "en-SG",
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(phase3Runtime.mutateCompetition).toHaveBeenCalledWith(
      expect.anything(),
      competitionId,
      expect.objectContaining({
        action: "update",
        patch: expect.objectContaining({ sportCode: "volleyball", locality: null, startsOn: "2027-04-01" }),
      }),
      expect.any(String),
    );

    const missingReason = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}/lifecycle`,
      headers,
      payload: { action: "withdraw" },
    });
    const missingReplacement = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}/lifecycle`,
      headers,
      payload: { action: "replace" },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReplacement.statusCode).toBe(400);

    const withdrawal = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}/lifecycle`,
      headers,
      payload: { action: "withdraw", reason: "Unavailable" },
    });
    expect(withdrawal.statusCode).toBe(200);
    expect(phase3Runtime.mutateEntry).toHaveBeenCalledWith(
      expect.anything(),
      competitionId,
      divisionId,
      { action: "withdraw", entryId, reason: "Unavailable" },
      expect.any(String),
      expect.any(String),
    );

    const importId = randomUUID();
    const rollback = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/imports/${importId}/rollback`,
      headers,
    });
    expect(rollback.statusCode).toBe(200);
    expect(phase3Runtime.rollbackEntryImport).toHaveBeenCalledWith(
      expect.anything(),
      competitionId,
      divisionId,
      importId,
      expect.any(String),
    );
  });

  it("rejects malformed format graph bodies before invoking persistence", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const headers = {
      cookie: "matchday_session=session",
      origin: "http://127.0.0.1:3000",
      "x-csrf-token": "csrf-ok",
    };
    const url = `/api/v1/competitions/${randomUUID()}/divisions/${randomUUID()}/format-revisions`;
    const valid = validFormatGraph();
    const malformed = [
      { definition: { ...valid, stages: "not-an-array" } },
      {
        definition: {
          ...valid,
          matches: [{ ...valid.matches[0], home: { type: "entry_seed" } }],
        },
      },
      {
        definition: {
          ...valid,
          matches: [{ ...valid.matches[0], away: { type: "entrant", seed: 2 } }],
        },
      },
      { definition: { ...valid, matches: new Array(1_129).fill(valid.matches[0]) } },
    ];
    for (const payload of malformed) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    const invalidJson = await app.inject({
      method: "POST",
      url,
      headers: { ...headers, "content-type": "application/json" },
      payload: '{"definition":',
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(phase3Runtime.createFormatRevision).not.toHaveBeenCalled();
  });

  it("passes a structurally valid format graph to the runtime without an unsafe cast", async () => {
    const phase3Runtime = runtime();
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: identityRuntime(),
      phase3Runtime,
    });
    apps.push(app);
    const competitionId = randomUUID();
    const divisionId = randomUUID();
    const definition = validFormatGraph();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/divisions/${divisionId}/format-revisions`,
      headers: {
        cookie: "matchday_session=session",
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": "csrf-ok",
      },
      payload: { definition },
    });
    expect(response.statusCode).toBe(201);
    expect(phase3Runtime.createFormatRevision).toHaveBeenCalledWith(
      expect.anything(),
      competitionId,
      divisionId,
      definition,
      expect.any(String),
    );
  });
});
