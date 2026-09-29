import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@matchday/config";
import type { Phase4FormatBuilderDocument, ScheduleConstraints } from "@matchday/contracts";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { createDefaultFormatTemplates } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { buildApp } from "../../src/app.js";
import { ErrorCode } from "../../src/errors.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime } from "../../src/phase-3-runtime.js";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const config = parseConfig(process.env);
const schema = `test_phase4_officials_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let phase3!: Phase3Runtime;
let phase2!: Phase2Runtime;
let phase4!: Phase4Runtime;
let app!: Awaited<ReturnType<typeof buildApp>>;

let ownerId = "";
let viewerId = "";
let otherOrgOwnerId = "";
let org1Id = "";
let org2Id = "";
let comp1Id = "";
let comp2Id = "";

let divisionId = "";
let match1Id = "";
let match2Id = "";
let areaId = "";

function ownerHeaders(origin = "http://localhost:3000") {
  return {
    origin,
    "x-csrf-token": "csrf-owner",
    cookie: "matchday_session=owner-token",
  };
}

function viewerHeaders() {
  return {
    origin: "http://localhost:3000",
    "x-csrf-token": "csrf-viewer",
    cookie: "matchday_session=viewer-token",
  };
}

function otherOrgHeaders() {
  return {
    origin: "http://localhost:3000",
    "x-csrf-token": "csrf-other",
    cookie: "matchday_session=other-token",
  };
}

function mockIdentityRuntime(): IdentityApiRuntime {
  return {
    authenticate: vi.fn(async (token: string) => {
      if (token === "owner-token") {
        return {
          account: {
            id: ownerId,
            primaryEmail: "owner@matchday.test",
            displayName: "Owner",
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: "csrf-owner",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }
      if (token === "viewer-token") {
        return {
          account: {
            id: viewerId,
            primaryEmail: "viewer@matchday.test",
            displayName: "Viewer",
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: "csrf-viewer",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }
      if (token === "other-token") {
        return {
          account: {
            id: otherOrgOwnerId,
            primaryEmail: "other@matchday.test",
            displayName: "Other Org Owner",
            status: "active",
            emailVerifiedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sessionId: randomUUID(),
          sessionToken: token,
          csrfToken: "csrf-other",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        };
      }
      throw new Error("Invalid session token");
    }),
    verifyCsrfToken: vi.fn((token: string, csrf: string) => {
      if (token === "owner-token") return csrf === "csrf-owner";
      if (token === "viewer-token") return csrf === "csrf-viewer";
      if (token === "other-token") return csrf === "csrf-other";
      return false;
    }),
  } as unknown as IdentityApiRuntime;
}

beforeAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  client = postgres(config.databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });

  // 1. Seed accounts
  const [owner] = await client<{ id: string }[]>`
    INSERT INTO accounts(primary_email, display_name, email_verified_at)
    VALUES('owner@matchday.test', 'Owner', now()) RETURNING id`;
  ownerId = owner!.id;

  const [viewer] = await client<{ id: string }[]>`
    INSERT INTO accounts(primary_email, display_name, email_verified_at)
    VALUES('viewer@matchday.test', 'Viewer', now()) RETURNING id`;
  viewerId = viewer!.id;

  const [other] = await client<{ id: string }[]>`
    INSERT INTO accounts(primary_email, display_name, email_verified_at)
    VALUES('other@matchday.test', 'Other Owner', now()) RETURNING id`;
  otherOrgOwnerId = other!.id;

  // 2. Seed organisations & memberships in transactions so constraint triggers pass
  await client.begin(async (tx) => {
    const [org1] = await tx<{ id: string }[]>`
      INSERT INTO organisations(name, slug) VALUES('Primary Org', 'primary-org') RETURNING id`;
    org1Id = org1!.id;
    await tx`
      INSERT INTO organisation_memberships(organisation_id, account_id, role, status)
      VALUES (${org1Id}, ${ownerId}, 'owner', 'active'),
             (${org1Id}, ${viewerId}, 'viewer', 'active')`;
  });

  await client.begin(async (tx) => {
    const [org2] = await tx<{ id: string }[]>`
      INSERT INTO organisations(name, slug) VALUES('Secondary Org', 'secondary-org') RETURNING id`;
    org2Id = org2!.id;
    await tx`
      INSERT INTO organisation_memberships(organisation_id, account_id, role, status)
      VALUES (${org2Id}, ${otherOrgOwnerId}, 'owner', 'active')`;
  });

  // 3. Initialize runtimes
  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
  phase2 = new Phase2Runtime(
    client as unknown as PostgresJsSql,
    phase2DomainAdapter,
    undefined,
    undefined,
    "phase-4-runtime-fallback-code-hmac-secret",
  );
  phase4 = new Phase4Runtime(
    client as unknown as PostgresJsSql,
    phase3,
    { enqueueSchedule: async () => ({ id: "sched-job", name: "schedule.optimize", duplicate: false }) },
    {
      mode: "stub",
      provider: new DeterministicPhase4AiStub(),
      timeoutMs: 2000,
      maximumAttempts: 1,
      cacheTtlSeconds: 3600,
    },
    undefined,
    phase2,
  );

  // 4. Seed competitions
  const comp1 = await phase3.createCompetition(
    { accountId: ownerId },
    {
      organisationId: org1Id,
      name: "Officials Test Cup 1",
      slug: `officials-test-cup-1-${randomUUID()}`,
      sportCode: "canoe_polo",
      venue: "Pool 1",
      address: "1 Pool Way",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  comp1Id = comp1.id;

  const comp2 = await phase3.createCompetition(
    { accountId: ownerId },
    {
      organisationId: org1Id,
      name: "Officials Test Cup 2",
      slug: `officials-test-cup-2-${randomUUID()}`,
      sportCode: "canoe_polo",
      venue: "Pool 2",
      address: "2 Pool Way",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  comp2Id = comp2.id;

  const otherComp = await phase3.createCompetition(
    { accountId: otherOrgOwnerId },
    {
      organisationId: org2Id,
      name: "Other Org Cup",
      slug: `other-org-cup-${randomUUID()}`,
      sportCode: "canoe_polo",
      venue: "Pool 3",
      address: "3 Pool Way",
      countryCode: "SG",
      startsOn: "2027-08-01",
      endsOn: "2027-08-02",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    },
    randomUUID(),
  );
  void otherComp.id; // captured for seeding, not used in assertions

  // 5. Seed playing area and capacity for comp1
  const [area] = await client<{ id: string }[]>`
    INSERT INTO playing_areas(competition_id, name, slot_minutes, sort_order)
    VALUES(${comp1Id}, 'Pitch A', 30, 1) RETURNING id`;
  areaId = area!.id;

  await client`
    INSERT INTO competition_availability_windows(competition_id, playing_area_id, starts_at, ends_at)
    VALUES(${comp1Id}, ${areaId}, '2027-08-01 08:00:00+08', '2027-08-01 18:00:00+08')`;

  // 6. Seed division, entries and format with materialised matches for comp1
  const [div] = await client<{ id: string }[]>`
    INSERT INTO divisions(competition_id, name, team_limit)
    VALUES(${comp1Id}, 'Open Division', 8) RETURNING id`;
  divisionId = div!.id;

  await client`
    INSERT INTO division_entries(division_id, name, seed, status, entry_type)
    SELECT ${divisionId}, 'Team ' || s, s, 'active', 'team'
    FROM generate_series(1, 8) s`;

  const templateGraph = structuredClone(createDefaultFormatTemplates(8)[0]!.graph);
  const formatDoc: Phase4FormatBuilderDocument = {
    schema_version: 1,
    graph: templateGraph,
    layout: {
      schema_version: 1,
      stage_positions: templateGraph.stages.map((stage, index) => ({
        stage_id: stage.id,
        x: index * 240,
        y: 80,
      })),
    },
  };

  const draft = await phase4.saveFormatRevision(
    { accountId: ownerId },
    comp1Id,
    divisionId,
    {
      draft_id: null,
      expected_revision: null,
      parent_revision_id: null,
      document: formatDoc,
      idempotency_key: `format-${randomUUID()}`,
    },
    randomUUID(),
  );

  await phase4.materialiseFormat({ accountId: ownerId }, draft.draft_id, `mat-${randomUUID()}`, randomUUID());

  await client`SELECT phase4_publish_format_revision(${draft.draft_id}, ${ownerId}, ${`pub-${randomUUID()}`})`;

  const matches = await client<{ id: string }[]>`
    SELECT id FROM matches WHERE competition_id = ${comp1Id} ORDER BY ordinal ASC LIMIT 2`;
  match1Id = matches[0]!.id;
  match2Id = matches[1]!.id;

  // Also create a real match in comp2 to test cross-competition isolation
  const [div2] = await client<{ id: string }[]>`
    INSERT INTO divisions(competition_id, name, team_limit)
    VALUES(${comp2Id}, 'Comp 2 Division', 8) RETURNING id`;

  await client`
    INSERT INTO division_entries(division_id, name, seed, status, entry_type)
    SELECT ${div2!.id}, 'Comp 2 Team ' || s, s, 'active', 'team'
    FROM generate_series(1, 8) s`;

  const draft2 = await phase4.saveFormatRevision(
    { accountId: ownerId },
    comp2Id,
    div2!.id,
    {
      draft_id: null,
      expected_revision: null,
      parent_revision_id: null,
      document: formatDoc,
      idempotency_key: `format2-${randomUUID()}`,
    },
    randomUUID(),
  );

  await phase4.materialiseFormat({ accountId: ownerId }, draft2.draft_id, `mat2-${randomUUID()}`, randomUUID());

  const comp2Matches = await client<{ id: string }[]>`
    SELECT id FROM matches WHERE competition_id = ${comp2Id} LIMIT 1`;
  void comp2Matches[0]?.id; // seeded but not used in assertions

  // 7. Build Fastify app
  app = await buildApp({
    config: testConfig(),
    probes: healthyProbes,
    identityRuntime: mockIdentityRuntime(),
    phase3Runtime: phase3,
    phase4Runtime: phase4,
    phase2Runtime: phase2,
  });
}, 30_000);

afterAll(async () => {
  await app?.close();
  await client?.end({ timeout: 2 });
  await dropTestSchema(config.databaseUrl, schema);
});

describe("Phase 4 Officials & Availability API (Checkpoint 3)", () => {
  describe("Suite 1: Authentication and CSRF Fencing", () => {
    it("rejects unauthenticated official listing with 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.AUTHENTICATION_REQUIRED);
    });

    it("rejects unauthenticated official creation with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "unauth-csrf",
        },
        body: { name: "Ghost Ref" },
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.AUTHENTICATION_REQUIRED);
    });

    it("rejects official creation with missing or mismatched CSRF token with 403", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "wrong-csrf",
          cookie: "matchday_session=owner-token",
        },
        body: { name: "Bad CSRF Ref" },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.CSRF_INVALID);
    });

    it("rejects availability replacement with invalid CSRF token with 403", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${randomUUID()}/availability`,
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "bad-csrf",
          cookie: "matchday_session=owner-token",
        },
        body: { windows: [] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects match assignments replacement with invalid CSRF token with 403", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "bad-csrf",
          cookie: "matchday_session=owner-token",
        },
        body: { assignments: [] },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("Suite 2: Role & Multi-Tenant Authorization", () => {
    it("forbids viewers from creating officials with 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: viewerHeaders(),
        body: { name: "Viewer Attempt Ref" },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.COMPETITION_ACCESS_DENIED);
    });

    it("forbids viewers from replacing availability with 404", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${randomUUID()}/availability`,
        headers: viewerHeaders(),
        body: { windows: [] },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.COMPETITION_ACCESS_DENIED);
    });

    it("forbids viewers from replacing match officials with 404", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: viewerHeaders(),
        body: { assignments: [] },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.COMPETITION_ACCESS_DENIED);
    });

    it("forbids non-members from accessing competition officials with 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: otherOrgHeaders(),
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.COMPETITION_ACCESS_DENIED);
    });

    it("forbids non-members from mutating competition officials with 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: otherOrgHeaders(),
        body: { name: "Cross Org Ref" },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.COMPETITION_ACCESS_DENIED);
    });
  });

  describe("Suite 3: Official CRUD & Lifecycle Management", () => {
    let aliceId = "";
    let bobId = "";

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "Alice Smith", default_role: "Referee" },
      });
      aliceId = JSON.parse(res.body).id;

      const bobRes = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "Bob Brown", default_role: "Line Judge" },
      });
      bobId = JSON.parse(bobRes.body).id;
    });

    it("creates an official with valid data and returns 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "Charlie Davis", default_role: "Scorekeeper" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        competition_id: comp1Id,
        name: "Charlie Davis",
        default_role: "Scorekeeper",
        archived: false,
      });
      expect(body.id).toBeDefined();
    });

    it("rejects duplicate active official name with 409 OFFICIAL_NAME_CONFLICT", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "  alice smith  " }, // case-insensitive, trimmed collision
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCode.OFFICIAL_NAME_CONFLICT);
    });

    it("gets an official by ID", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${aliceId}`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(aliceId);
      expect(body.name).toBe("Alice Smith");
    });

    it("lists active officials", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items.some((o: { id: string }) => o.id === aliceId)).toBe(true);
    });

    it("patches an official to rename and change default role", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${aliceId}`,
        headers: ownerHeaders(),
        body: { name: "Alice Johnson", default_role: "Chief Referee" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Alice Johnson");
      expect(body.default_role).toBe("Chief Referee");
    });

    it("prevents renaming Bob to Alice Johnson with 409 OFFICIAL_NAME_CONFLICT", async () => {
      const renameRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${bobId}`,
        headers: ownerHeaders(),
        body: { name: "Alice Johnson" },
      });
      expect(renameRes.statusCode).toBe(409);
      expect(JSON.parse(renameRes.body).error.code).toBe(ErrorCode.OFFICIAL_NAME_CONFLICT);
    });

    it("archives Bob Brown and removes him from active list", async () => {
      const archiveRes = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${bobId}/archive`,
        headers: ownerHeaders(),
      });
      expect(archiveRes.statusCode).toBe(200);
      const archived = JSON.parse(archiveRes.body);
      expect(archived.official.archived).toBe(true);
      expect(archived.bumped_revision).toBe(false);

      // List active officials - Bob should not be included
      const listActive = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
      });
      expect(JSON.parse(listActive.body).items.some((o: { id: string }) => o.id === bobId)).toBe(false);

      // List with include_archived=true - Bob should be included
      const listAll = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials?include_archived=true`,
        headers: ownerHeaders(),
      });
      expect(JSON.parse(listAll.body).items.some((o: { id: string }) => o.id === bobId)).toBe(true);
    });

    it("allows creating a new active official with the same name as the archived official", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "Bob Brown", default_role: "New Role" },
      });
      expect(res.statusCode).toBe(201);
      const newBob = JSON.parse(res.body);
      expect(newBob.name).toBe("Bob Brown");
      expect(newBob.id).not.toBe(bobId);

      // Attempting to restore the original Bob now fails because of name conflict
      const restoreFail = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${bobId}/restore`,
        headers: ownerHeaders(),
      });
      expect(restoreFail.statusCode).toBe(409);
      expect(JSON.parse(restoreFail.body).error.code).toBe(ErrorCode.OFFICIAL_NAME_CONFLICT);

      // Archive new Bob, then restoring original Bob succeeds
      await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${newBob.id}/archive`,
        headers: ownerHeaders(),
      });

      const restoreOk = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${bobId}/restore`,
        headers: ownerHeaders(),
      });
      expect(restoreOk.statusCode).toBe(200);
      expect(JSON.parse(restoreOk.body).official.archived).toBe(false);
    });

    it("supports the standard /api/v1/competitions prefix as well as /api/v1/phase4/competitions", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).items.some((o: { id: string }) => o.id === aliceId)).toBe(true);
    });
  });

  describe("Suite 4: Official Availability Validation & Semantics", () => {
    let officialId = "";

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
        headers: ownerHeaders(),
        body: { name: "Availability Official" },
      });
      officialId = JSON.parse(res.body).id;
    });

    it("rejects window where starts_at >= ends_at with 400 OFFICIAL_AVAILABILITY_INVALID", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialId}/availability`,
        headers: ownerHeaders(),
        body: {
          windows: [
            {
              starts_at: "2027-08-01T14:00:00.000Z",
              ends_at: "2027-08-01T12:00:00.000Z",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe(ErrorCode.OFFICIAL_AVAILABILITY_INVALID);
    });

    it("rejects invalid date strings with 400 OFFICIAL_AVAILABILITY_INVALID", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialId}/availability`,
        headers: ownerHeaders(),
        body: {
          windows: [
            {
              starts_at: "not-a-date",
              ends_at: "also-not-a-date",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect([ErrorCode.OFFICIAL_AVAILABILITY_INVALID, "VALIDATION_ERROR"]).toContain(JSON.parse(res.body).error.code);
    });

    it("merges overlapping and contiguous intervals into canonical windows", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialId}/availability`,
        headers: ownerHeaders(),
        body: {
          windows: [
            { starts_at: "2027-08-01T09:00:00.000Z", ends_at: "2027-08-01T11:00:00.000Z" },
            { starts_at: "2027-08-01T10:00:00.000Z", ends_at: "2027-08-01T12:00:00.000Z" },
            { starts_at: "2027-08-01T12:00:00.000Z", ends_at: "2027-08-01T14:00:00.000Z" }, // contiguous
            { starts_at: "2027-08-01T16:00:00.000Z", ends_at: "2027-08-01T18:00:00.000Z" }, // disjoint
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.windows).toEqual([
        { starts_at: "2027-08-01T09:00:00.000Z", ends_at: "2027-08-01T14:00:00.000Z" },
        { starts_at: "2027-08-01T16:00:00.000Z", ends_at: "2027-08-01T18:00:00.000Z" },
      ]);
      // Since official is unassigned, bumped_revision is false
      expect(body.bumped_revision).toBe(false);
    });

    it("performs semantic no-op check when windows produce identical canonical intervals", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      // Send overlapping chunks that reduce to the same 2 canonical windows
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialId}/availability`,
        headers: ownerHeaders(),
        body: {
          windows: [
            { starts_at: "2027-08-01T09:00:00.000Z", ends_at: "2027-08-01T14:00:00.000Z" },
            { starts_at: "2027-08-01T16:00:00.000Z", ends_at: "2027-08-01T18:00:00.000Z" },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(false);

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision);
    });

    it("reads official availability via GET endpoint", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialId}/availability`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.windows).toHaveLength(2);
      expect(body.windows[0]).toEqual({
        starts_at: "2027-08-01T09:00:00.000Z",
        ends_at: "2027-08-01T14:00:00.000Z",
      });
    });
  });

  describe("Suite 5: Match Official Assignments & Revision Semantics", () => {
    let officialAId = "";
    let officialBId = "";
    let archivedOfficialId = "";
    let otherCompOfficialId = "";

    beforeAll(async () => {
      const [resA, resB, resArchived, resOtherComp] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
          headers: ownerHeaders(),
          body: { name: "Official Alpha", default_role: "Main Ref" },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
          headers: ownerHeaders(),
          body: { name: "Official Beta", default_role: "Asst Ref" },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/phase4/competitions/${comp1Id}/officials`,
          headers: ownerHeaders(),
          body: { name: "Official Archived", default_role: "Bench" },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/phase4/competitions/${comp2Id}/officials`,
          headers: ownerHeaders(),
          body: { name: "Comp 2 Official" },
        }),
      ]);

      officialAId = JSON.parse(resA.body).id;
      officialBId = JSON.parse(resB.body).id;
      archivedOfficialId = JSON.parse(resArchived.body).id;
      otherCompOfficialId = JSON.parse(resOtherComp.body).id;

      // Archive the third official
      await app.inject({
        method: "POST",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${archivedOfficialId}/archive`,
        headers: ownerHeaders(),
      });
    });

    it("rejects assigning to non-existent match with 404 MATCH_NOT_FOUND", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${randomUUID()}/officials`,
        headers: ownerHeaders(),
        body: { assignments: [{ official_id: officialAId }] },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe(ErrorCode.MATCH_NOT_FOUND);
    });

    it("rejects duplicate official_id in same match assignment request with 400 OFFICIAL_ASSIGNMENT_INVALID", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [
            { official_id: officialAId, assigned_role: "Referee" },
            { official_id: officialAId, assigned_role: "Umpire" },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe(ErrorCode.OFFICIAL_ASSIGNMENT_INVALID);
    });

    it("rejects assigning an archived official with 409 OFFICIAL_ARCHIVED", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [{ official_id: archivedOfficialId }],
        },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe(ErrorCode.OFFICIAL_ARCHIVED);
    });

    it("rejects assigning an official from a different competition with 404 OFFICIAL_NOT_FOUND", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [{ official_id: otherCompOfficialId }],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe(ErrorCode.OFFICIAL_NOT_FOUND);
    });

    it("assigns Official Alpha to Match 1, bumps revision, and returns assignments", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [{ official_id: officialAId, assigned_role: "Lead Referee" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(true);
      expect(body.assignments).toEqual([
        { match_id: match1Id, official_id: officialAId, assigned_role: "Lead Referee" },
      ]);

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision + 1);
    });

    it("reads match officials via GET endpoint with embedded official metadata", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({
        match_id: match1Id,
        official_id: officialAId,
        assigned_role: "Lead Referee",
        official: {
          id: officialAId,
          name: "Official Alpha",
          default_role: "Main Ref",
          archived: false,
        },
      });
    });

    it("performs exact replay no-op: does not bump revision when assignments and roles are identical", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [{ official_id: officialAId, assigned_role: "Lead Referee" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(false);

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision);
    });

    it("performs role-only metadata update no-op: updates assigned_role without bumping revision", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [{ official_id: officialAId, assigned_role: "Solo Referee" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(false);
      expect(body.assignments[0].assigned_role).toBe("Solo Referee");

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision);
    });

    it("bumps revision when official membership changes (adding Official Beta)", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: {
          assignments: [
            { official_id: officialAId, assigned_role: "Solo Referee" },
            { official_id: officialBId, assigned_role: "Table Official" },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(true);
      expect(body.assignments).toHaveLength(2);

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision + 1);
    });

    it("bumps revision when an assigned official's availability actually changes", async () => {
      const compBefore = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      // Official Alpha is assigned to Match 1. Change Alpha's availability
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/${officialAId}/availability`,
        headers: ownerHeaders(),
        body: {
          windows: [{ starts_at: "2027-08-01T08:00:00.000Z", ends_at: "2027-08-01T12:00:00.000Z" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bumped_revision).toBe(true);

      const compAfter = (
        await client<{ revision: number }[]>`SELECT revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(compAfter.revision).toBe(compBefore.revision + 1);
    });
  });

  describe("Suite 6: Official Workspace Endpoint", () => {
    it("returns complete official workspace in a single round-trip", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/phase4/competitions/${comp1Id}/officials/workspace`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.officials)).toBe(true);
      expect(body.officials.length).toBeGreaterThan(0);
      expect(typeof body.availability).toBe("object");
      expect(Array.isArray(body.assignments)).toBe(true);
      expect(body.assignments.length).toBeGreaterThan(0);

      // Verify assignment contains embedded official metadata
      const assigned = body.assignments.find(
        (a: { match_id: string; official: { name: string } }) => a.match_id === match1Id,
      );
      expect(assigned).toBeDefined();
      expect(assigned.official).toBeDefined();
      expect(assigned.official.name).toBeDefined();
    });
  });

  describe("Suite 7: Schedule Problem Construction (buildScheduleProblem)", () => {
    it("populates matches.official_ids, assigned-only availability, and canonical intervals in solver input", async () => {
      const comp = (
        await client<{ revision: number; capacity_revision: number }[]>`
        SELECT revision::int revision, capacity_revision::int capacity_revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      const constraints: ScheduleConstraints = {
        minimum_rest: { mode: "ignored", value: { minutes: 0 } },
        maximum_matches_per_day: { mode: "ignored", value: { matches: 8 } },
        preferred_final_time: {
          mode: "ignored",
          value: { target_start_epoch_ms: Date.parse("2027-08-01T12:00:00Z"), tolerance_minutes: 60 },
        },
        entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
        official_availability: {
          mode: "preferred",
          weight: 7,
          value: { by_official_id: {} },
        },
        featured_playing_area: { mode: "ignored", value: { area_id: areaId, match_ids: [] } },
        avoid_consecutive_matches: { mode: "ignored", value: { minutes: 0 } },
        balance_early_matches: { mode: "ignored", value: { before_local_time: "09:00" } },
        balance_late_matches: { mode: "ignored", value: { at_or_after_local_time: "18:00" } },
        keep_division_together: { mode: "ignored", value: { maximum_area_count: 1 } },
        preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
      };

      const result = await phase4.generateSchedule(
        { accountId: ownerId },
        comp1Id,
        {
          idempotency_key: `gen-sched-${randomUUID()}`,
          expected_source_revision: Number(comp.revision),
          expected_capacity_revision: Number(comp.capacity_revision),
          objective: "balanced",
          constraints,
        },
        randomUUID(),
      );

      expect(result.job).toBeDefined();
      const jobId = result.job.id;

      const [jobRow] = await client<
        {
          input_snapshot: {
            matches: { match_id: string; official_ids: string[] }[];
            constraints: Record<string, unknown>;
          };
        }[]
      >`
        SELECT input_snapshot FROM schedule_generation_jobs WHERE id=${jobId}`;
      expect(jobRow).toBeDefined();

      const snapshot = jobRow!.input_snapshot;
      expect(snapshot.matches).toBeDefined();

      // Find Match 1 (has assigned officials) and Match 2 (unassigned)
      const snapMatch1 = snapshot.matches.find((m) => m.match_id === match1Id);
      const snapMatch2 = snapshot.matches.find((m) => m.match_id === match2Id);

      expect(snapMatch1).toBeDefined();
      const sm1 = snapMatch1!;
      expect(sm1.official_ids.length).toBeGreaterThan(0);
      // Ensure official_ids are sorted deterministically
      const sortedIds = [...sm1.official_ids].sort();
      expect(sm1.official_ids).toEqual(sortedIds);

      expect(snapMatch2).toBeDefined();
      expect(snapMatch2!.official_ids).toEqual([]);

      // Verify constraints.official_availability
      const officialAvail = snapshot.constraints.official_availability as {
        mode: string;
        weight: number;
        value: { by_official_id: Record<string, { start_epoch_ms: number; end_epoch_ms: number }[]> };
      };
      expect(officialAvail.mode).toBe("preferred");
      expect(officialAvail.weight).toBe(7);

      const byOfficialId = officialAvail.value.by_official_id;
      // All assigned officials must be in by_official_id
      for (const offId of sm1.official_ids) {
        expect(byOfficialId[offId]).toBeDefined();
        expect(Array.isArray(byOfficialId[offId])).toBe(true);
        for (const interval of byOfficialId[offId]!) {
          expect(typeof interval.start_epoch_ms).toBe("number");
          expect(typeof interval.end_epoch_ms).toBe("number");
          expect(interval.start_epoch_ms).toBeLessThan(interval.end_epoch_ms);
        }
      }

      // Any unassigned official must NOT be in by_official_id
      const allActiveOfficials = await client<{ id: string }[]>`
        SELECT id FROM competition_officials WHERE competition_id = ${comp1Id} AND archived_at IS NULL`;
      const assignedSet = new Set(sm1.official_ids);
      for (const off of allActiveOfficials) {
        if (!assignedSet.has(off.id)) {
          expect(byOfficialId[off.id]).toBeUndefined();
        }
      }

      await client`DELETE FROM schedule_generation_jobs WHERE id = ${jobId}`;
    });
  });

  describe("Suite 8: Stale-Job Fencing on Official Mutations", () => {
    it("fences schedule generation when assigned official availability changes", async () => {
      // 1. Snapshot the current competition revision
      const before = (
        await client<{ revision: number; capacity_revision: number }[]>`
        SELECT revision::int revision, capacity_revision::int capacity_revision
        FROM competitions WHERE id=${comp1Id}`
      )[0]!;

      // 2. Mutate match officials — this must bump competition revision
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/phase4/competitions/${comp1Id}/matches/${match1Id}/officials`,
        headers: ownerHeaders(),
        body: { assignments: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).bumped_revision).toBe(true);

      // 3. Verify competition revision actually incremented
      const after = (
        await client<{ revision: number }[]>`
        SELECT revision::int revision FROM competitions WHERE id=${comp1Id}`
      )[0]!;
      expect(after.revision).toBe(Number(before.revision) + 1);

      // 4. Attempting generateSchedule with the stale (old) revision fails with STALE_SCHEDULE_INPUT
      const constraints: ScheduleConstraints = {
        minimum_rest: { mode: "ignored", value: { minutes: 0 } },
        maximum_matches_per_day: { mode: "ignored", value: { matches: 8 } },
        preferred_final_time: {
          mode: "ignored",
          value: { target_start_epoch_ms: Date.parse("2027-08-01T12:00:00Z"), tolerance_minutes: 60 },
        },
        entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
        official_availability: { mode: "ignored", value: { by_official_id: {} } },
        featured_playing_area: { mode: "ignored", value: { area_id: areaId, match_ids: [] } },
        avoid_consecutive_matches: { mode: "ignored", value: { minutes: 0 } },
        balance_early_matches: { mode: "ignored", value: { before_local_time: "09:00" } },
        balance_late_matches: { mode: "ignored", value: { at_or_after_local_time: "18:00" } },
        keep_division_together: { mode: "ignored", value: { maximum_area_count: 1 } },
        preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
      };

      await expect(
        phase4.generateSchedule(
          { accountId: ownerId },
          comp1Id,
          {
            idempotency_key: `stale-fencing-${randomUUID()}`,
            expected_source_revision: Number(before.revision), // deliberately stale
            expected_capacity_revision: Number(before.capacity_revision),
            objective: "balanced",
            constraints,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCode.STALE_SCHEDULE_INPUT,
      });
    });
  });
});
