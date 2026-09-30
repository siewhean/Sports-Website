import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchOfficialsSummary } from "@/components/phase4/schedule/MatchOfficialsSummary";
import {
  phase4OfficialsCopy,
  toScheduleOfficialsProjection,
  type OfficialWorkspaceDocument,
  type ScheduleOfficialsProjection,
} from "@/lib/phase4-officials";
import {
  DEMO_SCOPE_COOKIE,
  demoScopeKey,
  getDemoOfficialWorkspace,
  getOfficialWorkspace,
  resetDemoOfficialWorkspaces,
  resolveDemoScope,
  updateDemoMatchAssignments,
} from "@/lib/phase4-officials.server";

let mockDemoScopeCookie: string | undefined = undefined;

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "matchday.test" }),
  cookies: async () => ({
    get: (name: string) => {
      if (name === DEMO_SCOPE_COOKIE && mockDemoScopeCookie) {
        return { name, value: mockDemoScopeCookie };
      }
      if (name === "matchday_session") {
        return { name, value: "valid-session" };
      }
      return undefined;
    },
  }),
}));

const competitionId = "10000000-0000-4000-8000-000000000001";
const match1Id = "30000000-0000-4000-8000-000000000001";
const match2Id = "30000000-0000-4000-8000-000000000002";
const officialAId = "60000000-0000-4000-8000-000000000001";
const officialBId = "60000000-0000-4000-8000-000000000002";
const officialCId = "60000000-0000-4000-8000-000000000003";

function createMockWorkspace(canEdit = true): OfficialWorkspaceDocument {
  return {
    state: "ready",
    competitionId,
    canEdit,
    officials: [
      {
        id: officialAId,
        competitionId,
        name: "Aisha Tan",
        defaultRole: "Lead Official",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: officialBId,
        competitionId,
        name: "Marcus Koh",
        defaultRole: "Line Judge",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: officialCId,
        competitionId,
        name: "Daniel Lim",
        defaultRole: null,
        archived: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    availability: {
      [officialAId]: [{ startsAt: "2026-10-01T09:00:00.000Z", endsAt: "2026-10-01T17:00:00.000Z" }],
      [officialBId]: [],
      [officialCId]: [],
    },
    assignments: [
      {
        matchId: match1Id,
        officialId: officialAId,
        assignedRole: "Head Referee",
      },
      {
        matchId: match1Id,
        officialId: officialBId,
        assignedRole: null,
      },
      {
        matchId: match2Id,
        officialId: officialCId,
        assignedRole: null,
      },
    ],
  };
}

describe("Schedule Officials Integration (CP 5.5)", () => {
  describe("toScheduleOfficialsProjection", () => {
    it("creates a narrow projection excluding availability and timestamps", () => {
      const workspace = createMockWorkspace(true);
      const projection = toScheduleOfficialsProjection(workspace);

      expect(projection.state).toBe("ready");
      expect(projection.canEdit).toBe(true);

      // Verify availability is NOT in projection
      expect((projection as unknown as Record<string, unknown>).availability).toBeUndefined();

      // Verify officials have only id, name, defaultRole, archived
      expect(projection.officials).toHaveLength(3);
      expect(projection.officials[0]).toEqual({
        id: officialAId,
        name: "Aisha Tan",
        defaultRole: "Lead Official",
        archived: false,
      });
      expect((projection.officials[0] as unknown as Record<string, unknown>).createdAt).toBeUndefined();
      expect((projection.officials[0] as unknown as Record<string, unknown>).updatedAt).toBeUndefined();

      // Verify archived official is retained
      const archived = projection.officials.find((o) => o.id === officialCId);
      expect(archived).toBeDefined();
      expect(archived?.archived).toBe(true);

      // Verify assignments membership retained
      expect(projection.assignments).toHaveLength(3);
      expect(projection.assignments[0]).toEqual({
        matchId: match1Id,
        officialId: officialAId,
        assignedRole: "Head Referee",
      });
    });

    it("preserves read-only canEdit state", () => {
      const workspace = createMockWorkspace(false);
      const projection = toScheduleOfficialsProjection(workspace);
      expect(projection.canEdit).toBe(false);
    });

    it("preserves non-ready surface state", () => {
      const workspace: OfficialWorkspaceDocument = {
        ...createMockWorkspace(),
        state: "error",
      };
      const projection = toScheduleOfficialsProjection(workspace);
      expect(projection.state).toBe("error");
    });
  });

  describe("MatchOfficialsSummary Component", () => {
    it("renders single assigned official with assigned role", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Officials");
      expect(html).toContain("Aisha Tan");
      expect(html).toContain("Lead Official");
      expect(html).toContain(phase4OfficialsCopy.manageOfficials);
      expect(html).toContain(`/organiser/competitions/${competitionId}/officials?match=${match1Id}`);
    });

    it("renders multiple assigned officials distinguishing assigned role vs default role", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [
          { id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false },
          { id: officialBId, name: "Marcus Koh", defaultRole: "Line Judge", archived: false },
        ],
        assignments: [
          { matchId: match1Id, officialId: officialAId, assignedRole: "Table Official" },
          { matchId: match1Id, officialId: officialBId, assignedRole: null },
        ],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      // Aisha Tan has explicit assigned role
      expect(html).toContain("Aisha Tan");
      expect(html).toContain("Table Official");

      // Marcus Koh has null assigned role -> shows Default role: Line Judge
      expect(html).toContain("Marcus Koh");
      expect(html).toContain(phase4OfficialsCopy.defaultRoleHelper("Line Judge"));
    });

    it("renders 'No assigned role' when both assignedRole and defaultRole are null", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: null, archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: null }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Aisha Tan");
      expect(html).toContain(phase4OfficialsCopy.noAssignedRole);
    });

    it("renders 'Archived' badge for archived official and retains assignment", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialCId, name: "Daniel Lim", defaultRole: "Timekeeper", archived: true }],
        assignments: [{ matchId: match1Id, officialId: officialCId, assignedRole: "Timekeeper" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Daniel Lim");
      expect(html).toContain(phase4OfficialsCopy.archivedBadge);
      expect(html).toContain("Timekeeper");
    });

    it("renders 'No officials assigned' when match has zero assignments", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: "other-match", officialId: officialAId, assignedRole: null }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.noOfficialsAssigned);
      expect(html).toContain(phase4OfficialsCopy.manageOfficials);
      expect(html).not.toContain("Aisha Tan");
    });

    it("renders 'Unknown official' when assignment official cannot be resolved, without leaking raw UUID", () => {
      const unresolvableId = "99999999-9999-4000-8000-999999999999";
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [], // empty officials roster
        assignments: [{ matchId: match1Id, officialId: unresolvableId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.unknownOfficial);
      expect(html).not.toContain(unresolvableId);
      expect(html).toContain("Lead Official");
    });

    it("renders 'Official assignments are temporarily unavailable' on workspace read error", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "error",
        canEdit: true,
        officials: [],
        assignments: [],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.officialsUnavailable);
      expect(html).not.toContain(phase4OfficialsCopy.noOfficialsAssigned);
    });

    it("renders 'View officials' when canEdit is false", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: false,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.viewOfficials);
      expect(html).not.toContain(phase4OfficialsCopy.manageOfficials);
    });
  });

  describe("Production Gating of officials_state (CP 5.5A)", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origMode = process.env.MATCHDAY_PHASE2_DATA_MODE;
    const origFixtures = process.env.MATCHDAY_ALLOW_DEMO_FIXTURES;
    const origAppEnv = process.env.APP_ENV;
    const origApiBase = process.env.MATCHDAY_API_BASE_URL;

    afterEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = origNodeEnv;
      process.env.MATCHDAY_PHASE2_DATA_MODE = origMode;
      process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = origFixtures;
      process.env.APP_ENV = origAppEnv;
      if (origApiBase) process.env.MATCHDAY_API_BASE_URL = origApiBase;
      else delete process.env.MATCHDAY_API_BASE_URL;
      vi.restoreAllMocks();
      resetDemoOfficialWorkspaces();
    });

    describe("in production environment (authoritative API read, non-demo)", () => {
      beforeEach(() => {
        delete process.env.MATCHDAY_PHASE2_DATA_MODE;
        delete process.env.MATCHDAY_ALLOW_DEMO_FIXTURES;
        process.env.APP_ENV = "production";
        process.env.MATCHDAY_API_BASE_URL = "https://matchday.test";
        process.env.MATCHDAY_PUBLIC_ORIGIN = "https://matchday.test";
      });

      it("ignores preview override in production: NODE_ENV=production officials_state=error -> authoritative API read wins", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";

        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request) => {
            expect(String(input)).toContain("/api/v1/phase4/competitions/");
            return Response.json({
              officials: [
                {
                  id: officialAId,
                  competition_id: competitionId,
                  name: "Aisha Tan",
                  default_role: "Lead Official",
                  archived: false,
                  created_at: "2026-08-01T00:00:00.000Z",
                  updated_at: "2026-08-01T00:00:00.000Z",
                },
              ],
              availability: {},
              assignments: [],
            });
          }),
        );

        const workspace = await getOfficialWorkspace(competitionId, true, "error");
        expect(workspace.state).toBe("ready");

        const projection = toScheduleOfficialsProjection(workspace);
        expect(projection.state).toBe("ready");
        expect(projection.officials.length).toBe(1);
        expect(projection.officials[0].name).toBe("Aisha Tan");
      });

      it("allows preview override in test: NODE_ENV=test officials_state=error -> error projection allowed", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = "test";

        const workspace = await getOfficialWorkspace(competitionId, true, "error");
        expect(workspace.state).toBe("error");

        const projection = toScheduleOfficialsProjection(workspace);
        expect(projection.state).toBe("error");
      });

      it("ignores offline and permission preview overrides in production", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";

        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json({
              officials: [],
              availability: {},
              assignments: [],
            }),
          ),
        );

        const offlineWs = await getOfficialWorkspace(competitionId, true, "offline");
        expect(offlineWs.state).toBe("ready");

        const permissionWs = await getOfficialWorkspace(competitionId, true, "permission");
        expect(permissionWs.state).toBe("ready");
      });

      it("allows offline and permission preview overrides in test", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = "test";

        const offlineWs = await getOfficialWorkspace(competitionId, true, "offline");
        expect(offlineWs.state).toBe("offline");

        const permissionWs = await getOfficialWorkspace(competitionId, true, "permission");
        expect(permissionWs.state).toBe("permission");
      });
    });

    describe("in local/test demo fixture mode", () => {
      beforeEach(() => {
        process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
        process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";
        process.env.APP_ENV = "test";
        resetDemoOfficialWorkspaces();
      });

      it("allows simulating degraded states for browser test validation", async () => {
        const errorWs = await getOfficialWorkspace(competitionId, true, "error");
        expect(errorWs.state).toBe("error");
        expect(toScheduleOfficialsProjection(errorWs).state).toBe("error");

        const offlineWs = await getOfficialWorkspace(competitionId, true, "offline");
        expect(offlineWs.state).toBe("offline");
      });
    });
  });

  describe("Demo Scope Isolation (CP 5.5A)", () => {
    beforeEach(() => {
      process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
      process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";
      process.env.APP_ENV = "test";
      resetDemoOfficialWorkspaces();
      mockDemoScopeCookie = undefined;
    });

    afterEach(() => {
      resetDemoOfficialWorkspaces();
      mockDemoScopeCookie = undefined;
    });

    it("resolves valid and fallback demo scope names", () => {
      expect(resolveDemoScope(undefined)).toBe("default");
      expect(resolveDemoScope(null)).toBe("default");
      expect(resolveDemoScope("")).toBe("default");
      expect(resolveDemoScope("   ")).toBe("default");
      expect(resolveDemoScope("cp55-roundtrip")).toBe("cp55-roundtrip");
      expect(resolveDemoScope("suite_1.test-run_2")).toBe("suite_1.test-run_2");
      expect(resolveDemoScope("has spaces")).toBe("default");
      expect(resolveDemoScope("bad@special!chars#")).toBe("default");
      expect(resolveDemoScope("a".repeat(81))).toBe("default");
      expect(resolveDemoScope("a".repeat(80))).toBe("a".repeat(80));
    });

    it("creates isolated demo store keys by scope and competition ID", () => {
      expect(demoScopeKey("scopeA", competitionId)).toBe(`scopeA:${competitionId}`);
      expect(demoScopeKey("", competitionId)).toBe(`default:${competitionId}`);
    });

    it("isolates mutations in Scope A from Scope B and default scope", () => {
      // 1. Initialise scopes
      const wsA = getDemoOfficialWorkspace(competitionId, true, "scopeA");
      const wsB = getDemoOfficialWorkspace(competitionId, true, "scopeB");
      const wsDef = getDemoOfficialWorkspace(competitionId, true, "default");

      // All start with Official A assigned to match 1
      expect(wsA.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);
      expect(wsB.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);
      expect(wsDef.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);

      // 2. Mutate Match 1 in Scope A to have Official B
      const updateResult = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialBId, assigned_role: "Line Judge" }],
        "scopeA",
      );
      expect(updateResult.ok).toBe(true);

      // 3. Verify Scope A is updated
      const updatedA = getDemoOfficialWorkspace(competitionId, true, "scopeA");
      expect(updatedA.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialBId);

      // 4. Verify Scope B and default are completely untouched
      const currentB = getDemoOfficialWorkspace(competitionId, true, "scopeB");
      expect(currentB.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);

      const currentDef = getDemoOfficialWorkspace(competitionId, true, "default");
      expect(currentDef.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);
    });

    it("supports scoped resets without affecting other running scopes", () => {
      updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialBId, assigned_role: "Line Judge" }],
        "scopeA",
      );
      updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialBId, assigned_role: "Line Judge" }],
        "scopeB",
      );

      // Reset only scope A
      resetDemoOfficialWorkspaces("scopeA");

      // Scope A returns fresh initial demo state (Official A on match 1)
      const freshA = getDemoOfficialWorkspace(competitionId, true, "scopeA");
      expect(freshA.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);

      // Scope B remains in its mutated state (Official B on match 1)
      const keptB = getDemoOfficialWorkspace(competitionId, true, "scopeB");
      expect(keptB.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialBId);
    });

    it("reads demo scope from matchday_demo_scope cookie in getOfficialWorkspace", async () => {
      mockDemoScopeCookie = "cookie-scope-xyz";

      // Mutate in this scope
      updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialBId, assigned_role: "Line Judge" }],
        "cookie-scope-xyz",
      );

      const ws = await getOfficialWorkspace(competitionId, true);
      const match1Assigned = ws.assignments.filter((a) => a.matchId === match1Id);
      expect(match1Assigned).toHaveLength(1);
      expect(match1Assigned[0].officialId).toBe(officialBId);

      // Default scope remains unmodified
      const defWs = getDemoOfficialWorkspace(competitionId, true, "default");
      expect(defWs.assignments.find((a) => a.matchId === match1Id)?.officialId).toBe(officialAId);
    });
  });

  describe("Demo Revision Semantics and Fail-Closed Validation (CP 5.5A)", () => {
    const scope = "rev-semantics-test";

    beforeEach(() => {
      process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
      process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";
      process.env.APP_ENV = "test";
      resetDemoOfficialWorkspaces(scope);
    });

    afterEach(() => {
      resetDemoOfficialWorkspaces(scope);
    });

    it("exact replay: same officials and same order -> bumped_revision=false", () => {
      // match1Id initially has [Official A]
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialAId, assigned_role: "Lead Official" }],
        scope,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(false);
      }
    });

    it("reordered replay: same officials in reversed order -> bumped_revision=false", () => {
      // First setup match1Id to have [A, B]
      const setup = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [
          { official_id: officialAId, assigned_role: "Lead Official" },
          { official_id: officialBId, assigned_role: "Line Judge" },
        ],
        scope,
      );
      expect(setup.ok).toBe(true);

      // Now submit reversed order [B, A]
      const reorder = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [
          { official_id: officialBId, assigned_role: "Line Judge" },
          { official_id: officialAId, assigned_role: "Lead Official" },
        ],
        scope,
      );
      expect(reorder.ok).toBe(true);
      if (reorder.ok) {
        expect(reorder.bumpedRevision).toBe(false);
      }
    });

    it("role-only change: same official with changed role -> bumped_revision=false", () => {
      // match1Id has [Official A] with "Lead Official"
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialAId, assigned_role: "Table Official" }],
        scope,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(false);
        expect(result.assignments[0].assignedRole).toBe("Table Official");
      }
    });

    it("add official: A -> A, B -> bumped_revision=true", () => {
      // match1Id initially has [Official A]
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [
          { official_id: officialAId, assigned_role: "Lead Official" },
          { official_id: officialBId, assigned_role: "Line Judge" },
        ],
        scope,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(true);
      }
    });

    it("remove official: A, B -> A -> bumped_revision=true", () => {
      // Setup match with [A, B]
      updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [
          { official_id: officialAId, assigned_role: "Lead Official" },
          { official_id: officialBId, assigned_role: "Line Judge" },
        ],
        scope,
      );

      // Remove B
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialAId, assigned_role: "Lead Official" }],
        scope,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(true);
      }
    });

    it("empty no-op: [] -> [] -> bumped_revision=false", () => {
      const emptyMatchId = "30000000-0000-4000-8000-000000000099";
      const result = updateDemoMatchAssignments(competitionId, emptyMatchId, [], scope);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(false);
      }
    });

    it("fail-closed: unknown official ID returns 404 OFFICIAL_NOT_FOUND", () => {
      const unknownId = "99999999-9999-4000-8000-999999999999";
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: unknownId, assigned_role: null }],
        scope,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.errorCode).toBe("OFFICIAL_NOT_FOUND");
        expect(result.message).toBe(phase4OfficialsCopy.officialNotFound);
      }
    });

    it("fail-closed: newly assigned archived official returns 400 OFFICIAL_ARCHIVED", () => {
      // officialCId is archived and NOT assigned to match1Id
      const result = updateDemoMatchAssignments(
        competitionId,
        match1Id,
        [{ official_id: officialCId, assigned_role: "Timekeeper" }],
        scope,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.errorCode).toBe("OFFICIAL_ARCHIVED");
        expect(result.message).toBe(phase4OfficialsCopy.archivedCannotReassign);
      }
    });

    it("allowed: retaining already assigned archived official succeeds with bumped_revision=false", () => {
      // In initial demo workspace, match2Id has officialBId and officialCId (archived)
      const result = updateDemoMatchAssignments(
        competitionId,
        match2Id,
        [
          { official_id: officialBId, assigned_role: "Line Judge" },
          { official_id: officialCId, assigned_role: "Timekeeper" },
        ],
        scope,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bumpedRevision).toBe(false);
      }
    });
  });
});
