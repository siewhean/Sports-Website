import { describe, expect, it, vi } from "vitest";
import {
  CompetitionRepository,
  OrganisationRepository,
  DivisionRepository,
  SetupRepository,
  FormatRepository,
  ScheduleRepository,
} from "../../src/repositories/index.js";
import { CreateCompetitionCommand, CreateCompetitionHandler } from "../../src/commands/index.js";
import { ApiError } from "../../src/errors.js";
import type { SqlExecutor } from "../../src/repositories/types.js";

function createMockSql(rows: unknown[] = []): SqlExecutor {
  const unsafe = vi.fn().mockResolvedValue(rows);
  return { unsafe } as unknown as SqlExecutor;
}

describe("V2 Architecture: Repository Layer", () => {
  it("CompetitionRepository finds by ID and checks slug existence with exact parameters", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "cmp_123", name: "Spring Cup", slug: "spring-cup" }])
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([]); // null path for non-existent ID
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new CompetitionRepository(executor);

    const comp = await repo.findById("cmp_123", "for_update");
    expect(comp).toEqual({ id: "cmp_123", name: "Spring Cup", slug: "spring-cup" });
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), ["cmp_123"]);

    const exists = await repo.existsBySlug("spring-cup", "cmp_123");
    expect(exists).toBe(true);
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("WHERE slug = $1 AND id != $2"), [
      "spring-cup",
      "cmp_123",
    ]);

    const nonExistent = await repo.findById("cmp_missing");
    expect(nonExistent).toBeNull();
  });

  it("CompetitionRepository creates new competition record with exact parameters", async () => {
    const mockSql = createMockSql([{ id: "cmp_new", revision: 1 }]);
    const repo = new CompetitionRepository(mockSql);

    const result = await repo.create({
      id: "cmp_new",
      organisationId: "org_1",
      createdBy: "acc_1",
      name: "Championship",
      slug: "championship",
      sportCode: "volleyball",
      venue: "Sports Hall",
      address: "123 Stadium Road",
      locality: "Central",
      countryCode: "SG",
      startsOn: "2026-09-01",
      endsOn: "2026-09-05",
      timezone: "Asia/Singapore",
      locale: "en-SG",
    });

    expect(result).toEqual({ id: "cmp_new", revision: 1 });
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO competitions"), [
      "cmp_new",
      "org_1",
      "acc_1",
      "Championship",
      "championship",
      "volleyball",
      "Sports Hall",
      "123 Stadium Road",
      "Central",
      "SG",
      "2026-09-01",
      "2026-09-05",
      "Asia/Singapore",
      "en-SG",
      "draft",
    ]);
  });

  it("OrganisationRepository checks active membership roles and acquires bootstrap lock", async () => {
    const mockSql = createMockSql([{ exists: true }]);
    const repo = new OrganisationRepository(mockSql);

    const hasRole = await repo.hasActiveRole("org_1", "acc_1", ["owner", "organiser"]);
    expect(hasRole).toBe(true);
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM organisation_memberships"), [
      "org_1",
      "acc_1",
      ["owner", "organiser"],
    ]);

    await repo.acquireBootstrapLock("acc_test");
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
      "organisation-bootstrap:acc_test",
    ]);
  });

  it("DivisionRepository queries entry counts and returns null when division is missing", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ count: "16" }])
      .mockResolvedValueOnce([]);
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new DivisionRepository(executor);

    const count = await repo.getEntryCount("div_456");
    expect(count).toBe(16);
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("WHERE division_id = $1"), ["div_456"]);

    const missing = await repo.findById("div_non_existent");
    expect(missing).toBeNull();
  });

  it("SetupRepository queries by competition ID with locking and handles missing drafts", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "setup_1", schema_version: 1, competition_id: "cmp_1", revision: 2 }])
      .mockResolvedValueOnce([]);
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new SetupRepository(executor);

    const draft = await repo.findByCompetitionId("cmp_1", "for_update");
    expect(draft).toEqual({ id: "setup_1", schema_version: 1, competition_id: "cmp_1", revision: 2 });
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE OF d"), ["cmp_1"]);

    const missing = await repo.findByCompetitionId("cmp_missing");
    expect(missing).toBeNull();
  });

  it("FormatRepository finds published revisions, lists by division, and batches by IDs", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "fmt_1", division_id: "div_1", status: "published" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "fmt_1", division_id: "div_1" },
        { id: "fmt_2", division_id: "div_2" },
      ]);
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new FormatRepository(executor);

    const fmt = await repo.findPublishedByDivisionId("div_1");
    expect(fmt?.status).toBe("published");
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("status = 'published'"), ["div_1"]);

    const missing = await repo.findById("fmt_missing");
    expect(missing).toBeNull();

    const batched = await repo.findByIds(["fmt_1", "fmt_2"]);
    expect(batched).toHaveLength(2);
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("WHERE id = ANY($1::uuid[])"), [["fmt_1", "fmt_2"]]);
  });

  it("ScheduleRepository acquires schedule mutation advisory lock with prefix and handles missing schedule", async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new ScheduleRepository(executor);

    await repo.acquireScheduleLock("cmp_789", "phase4-schedule");
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
      "phase4-schedule",
      "cmp_789",
    ]);

    const missing = await repo.findLatestPublished("cmp_missing");
    expect(missing).toBeNull();
  });
});

describe("V2 Architecture: Command Handlers", () => {
  it("CreateCompetitionHandler creates competition and returns revision when slug is free", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ exists: false }]) // existsBySlug check
      .mockResolvedValueOnce([{ id: "cmp_gen", revision: 1 }]); // insert
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new CompetitionRepository(executor);
    const handler = new CreateCompetitionHandler(repo);

    const command = new CreateCompetitionCommand({
      id: "cmp_gen",
      organisationId: "org_1",
      createdBy: "acc_1",
      name: "Championship 2026",
      slug: "championship-2026",
      sportCode: "basketball",
    });

    const result = await handler.execute(command);
    expect(result.slug).toBe("championship-2026");
    expect(result.id).toBe("cmp_gen");
    expect(result.revision).toBe(1);
  });

  it("CreateCompetitionHandler rejects duplicate slugs with ApiError 409 and ErrorCode", async () => {
    const mockSql = createMockSql([{ exists: true }]);
    const repo = new CompetitionRepository(mockSql);
    const handler = new CreateCompetitionHandler(repo);

    const command = new CreateCompetitionCommand({
      organisationId: "org_1",
      createdBy: "acc_1",
      name: "Existing Comp",
      slug: "existing-slug",
      sportCode: "basketball",
    });

    try {
      await handler.execute(command);
      expect.unreachable("Should have thrown ApiError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(409);
      expect(apiErr.code).toBe("COMPETITION_SLUG_TAKEN");
    }
  });

  it("CreateCompetitionHandler executes with transaction executor and advisory locking", async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([{ exists: false }]) // slug check
      .mockResolvedValueOnce([{ id: "cmp_tx", revision: 1 }]); // insert
    const executor = { unsafe: mockSql } as unknown as SqlExecutor;
    const repo = new CompetitionRepository(executor);
    const handler = new CreateCompetitionHandler(repo);

    const command = new CreateCompetitionCommand({
      id: "cmp_tx",
      organisationId: "org_1",
      createdBy: "acc_1",
      name: "Transactional Comp",
      slug: "tx-comp",
      sportCode: "canoe_polo",
    });

    const result = await handler.execute(command, executor);
    expect(result.id).toBe("cmp_tx");
    expect(mockSql).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
      "competition-slug:org_1:tx-comp",
    ]);
  });
});
