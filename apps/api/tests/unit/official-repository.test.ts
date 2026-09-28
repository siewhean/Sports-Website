import { describe, expect, it, vi } from "vitest";
import { OfficialRepository } from "../../src/repositories/index.js";
import type { SqlExecutor } from "../../src/repositories/types.js";

function createMockSql(): { sql: SqlExecutor; mockUnsafe: ReturnType<typeof vi.fn> } {
  const mockUnsafe = vi.fn().mockResolvedValue([]);
  const sql = { unsafe: mockUnsafe } as unknown as SqlExecutor;
  return { sql, mockUnsafe };
}

describe("OfficialRepository (Unit)", () => {
  const competitionId = "11111111-1111-4111-8111-111111111111";
  const organisationId = "22222222-2222-4222-8222-222222222222";
  const officialId = "33333333-3333-4333-8333-333333333333";
  const matchId = "44444444-4444-4444-8444-444444444444";

  it("createOfficial validates name length, creates record and emits audit events without bumping revision", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    // Expect name validation errors
    await expect(repo.createOfficial({ competitionId, organisationId, name: "   " })).rejects.toThrow(
      "Official name must be between 1 and 80 characters",
    );

    await expect(repo.createOfficial({ competitionId, organisationId, name: "x".repeat(81) })).rejects.toThrow(
      "Official name must be between 1 and 80 characters",
    );

    // Success case
    mockUnsafe.mockResolvedValueOnce([
      {
        id: officialId,
        competition_id: competitionId,
        organisation_id: organisationId,
        name: "Alex Smith",
        default_role: "Lead Referee",
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]); // INSERT competition_officials
    mockUnsafe.mockResolvedValueOnce([]); // INSERT audit_events
    mockUnsafe.mockResolvedValueOnce([]); // INSERT outbox_events

    const created = await repo.createOfficial({
      id: officialId,
      competitionId,
      organisationId,
      name: "  Alex Smith  ",
      defaultRole: "Lead Referee",
      actorId: "actor-1",
      requestId: "req-1",
    });

    expect(created.name).toBe("Alex Smith");
    expect(mockUnsafe).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO competition_officials"), [
      officialId,
      competitionId,
      organisationId,
      "Alex Smith",
      "Lead Referee",
    ]);
    // Audit event emitted
    expect(mockUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_events"),
      expect.arrayContaining([
        "req-1",
        "actor-1",
        "account",
        organisationId,
        "official.created",
        "competition_official",
        officialId,
      ]),
    );
    // No UPDATE competitions SET revision call
    expect(mockUnsafe).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), expect.anything());
  });

  it("updateOfficialMetadata updates name and role without bumping revision", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId, name: "Alex" },
    ]); // findById
    mockUnsafe.mockResolvedValueOnce([
      {
        id: officialId,
        competition_id: competitionId,
        organisation_id: organisationId,
        name: "Alexander",
        default_role: "Table",
      },
    ]); // UPDATE
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const updated = await repo.updateOfficialMetadata({
      competitionId,
      officialId,
      name: "Alexander",
      defaultRole: "Table",
    });

    expect(updated?.name).toBe("Alexander");
    expect(mockUnsafe).toHaveBeenCalledWith(expect.stringContaining("UPDATE competition_officials"), [
      "Alexander",
      "Table",
      officialId,
      competitionId,
    ]);
    expect(mockUnsafe).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), expect.anything());
  });

  it("archiveOfficial does not bump revision when official is unassigned", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId, name: "Alex" },
    ]); // findById
    mockUnsafe.mockResolvedValueOnce([{ count: "0" }]); // check assignments count -> 0
    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId, archived_at: new Date() },
    ]); // UPDATE archived_at
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const result = await repo.archiveOfficial({ competitionId, officialId });
    expect(result.bumpedRevision).toBe(false);
    expect(result.official?.archived_at).toBeDefined();
    expect(mockUnsafe).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), expect.anything());
  });

  it("archiveOfficial bumps revision when official has match assignments", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId, name: "Alex" },
    ]); // findById
    mockUnsafe.mockResolvedValueOnce([{ count: "2" }]); // check assignments count -> 2
    mockUnsafe.mockResolvedValueOnce([{ revision: 5 }]); // UPDATE competitions SET revision = revision + 1
    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId, archived_at: new Date() },
    ]); // UPDATE archived_at
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const result = await repo.archiveOfficial({ competitionId, officialId });
    expect(result.bumpedRevision).toBe(true);
    expect(mockUnsafe).toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), [competitionId]);
  });

  it("replaceAvailability validates intervals and bumps revision only if official has assignments", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    // Invalid interval: endsAt <= startsAt
    mockUnsafe.mockResolvedValueOnce([{ id: officialId, competition_id: competitionId }]);
    await expect(
      repo.replaceAvailability({
        competitionId,
        organisationId,
        officialId,
        windows: [{ startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T09:00:00Z" }],
      }),
    ).rejects.toThrow("Availability window must have positive duration");

    // Case 1: unassigned official -> no revision bump
    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId },
    ]);
    mockUnsafe.mockResolvedValueOnce([]); // existing windows
    mockUnsafe.mockResolvedValueOnce([{ count: "0" }]); // hasAssignments = false
    mockUnsafe.mockResolvedValueOnce([]); // DELETE
    mockUnsafe.mockResolvedValueOnce([
      { id: "w-1", starts_at: "2026-09-01T09:00:00Z", ends_at: "2026-09-01T12:00:00Z" },
    ]); // INSERT
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const unassignedResult = await repo.replaceAvailability({
      competitionId,
      organisationId,
      officialId,
      windows: [{ startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T12:00:00Z" }],
    });
    expect(unassignedResult.bumpedRevision).toBe(false);

    // Case 2: assigned official -> revision bump
    mockUnsafe.mockResolvedValueOnce([
      { id: officialId, competition_id: competitionId, organisation_id: organisationId },
    ]);
    mockUnsafe.mockResolvedValueOnce([]); // existing windows
    mockUnsafe.mockResolvedValueOnce([{ count: "1" }]); // hasAssignments = true
    mockUnsafe.mockResolvedValueOnce([{ revision: 6 }]); // increment revision
    mockUnsafe.mockResolvedValueOnce([]); // DELETE
    mockUnsafe.mockResolvedValueOnce([
      { id: "w-1", starts_at: "2026-09-01T09:00:00Z", ends_at: "2026-09-01T12:00:00Z" },
    ]); // INSERT
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const assignedResult = await repo.replaceAvailability({
      competitionId,
      organisationId,
      officialId,
      windows: [{ startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T12:00:00Z" }],
    });
    expect(assignedResult.bumpedRevision).toBe(true);
    expect(mockUnsafe).toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), [competitionId]);
  });

  it("replaceMatchAssignments rejects duplicates and always bumps competition revision", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    // Duplicate official in same match replacement
    mockUnsafe.mockResolvedValueOnce([{ id: matchId }]); // match exists
    mockUnsafe.mockResolvedValueOnce([{ id: officialId, competition_id: competitionId }]); // official exists
    await expect(
      repo.replaceMatchAssignments({
        competitionId,
        organisationId,
        matchId,
        assignments: [{ officialId }, { officialId }],
      }),
    ).rejects.toThrow("Duplicate official assignment for match");

    // Success replacement
    mockUnsafe.mockResolvedValueOnce([{ id: matchId }]); // match exists
    mockUnsafe.mockResolvedValueOnce([{ id: officialId, competition_id: competitionId }]); // official exists
    mockUnsafe.mockResolvedValueOnce([]); // existing assignments
    mockUnsafe.mockResolvedValueOnce([{ revision: 7 }]); // increment revision
    mockUnsafe.mockResolvedValueOnce([]); // DELETE match_official_assignments
    mockUnsafe.mockResolvedValueOnce([
      { id: "asgn-1", match_id: matchId, official_id: officialId, assigned_role: "Referee" },
    ]); // INSERT
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const result = await repo.replaceMatchAssignments({
      competitionId,
      organisationId,
      matchId,
      assignments: [{ officialId, assignedRole: "Referee" }],
    });

    expect(result.bumpedRevision).toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(mockUnsafe).toHaveBeenCalledWith(expect.stringContaining("UPDATE competitions"), [competitionId]);
  });

  it("assignOfficial and unassignOfficial always bump competition revision", async () => {
    const { sql, mockUnsafe } = createMockSql();
    const repo = new OfficialRepository(sql);

    // assignOfficial
    mockUnsafe.mockResolvedValueOnce([{ id: matchId }]); // match exists
    mockUnsafe.mockResolvedValueOnce([{ id: officialId, competition_id: competitionId }]); // official exists
    mockUnsafe.mockResolvedValueOnce([]); // existing assignment check -> empty
    mockUnsafe.mockResolvedValueOnce([{ revision: 8 }]); // increment revision
    mockUnsafe.mockResolvedValueOnce([
      { id: "asgn-2", match_id: matchId, official_id: officialId, assigned_role: null },
    ]); // INSERT
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const assignRes = await repo.assignOfficial({
      competitionId,
      organisationId,
      matchId,
      officialId,
    });
    expect(assignRes.bumpedRevision).toBe(true);

    // unassignOfficial
    mockUnsafe.mockResolvedValueOnce([{ id: "asgn-2" }]); // exists check
    mockUnsafe.mockResolvedValueOnce([{ revision: 9 }]); // increment revision
    mockUnsafe.mockResolvedValueOnce([]); // DELETE
    mockUnsafe.mockResolvedValueOnce([]); // audit
    mockUnsafe.mockResolvedValueOnce([]); // outbox

    const unassignRes = await repo.unassignOfficial({
      competitionId,
      organisationId,
      matchId,
      officialId,
    });
    expect(unassignRes.unassigned).toBe(true);
    expect(unassignRes.bumpedRevision).toBe(true);
  });
});
