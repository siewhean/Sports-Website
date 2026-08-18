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
  it("CompetitionRepository finds by ID and checks slug existence", async () => {
    const mockSql = createMockSql([{ id: "cmp_123", name: "Spring Cup", slug: "spring-cup" }]);
    const repo = new CompetitionRepository(mockSql);

    const comp = await repo.findById("cmp_123");
    expect(comp).toEqual({ id: "cmp_123", name: "Spring Cup", slug: "spring-cup" });
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM competitions"), ["cmp_123"]);
  });

  it("OrganisationRepository acquires advisory bootstrap lock", async () => {
    const mockSql = createMockSql([]);
    const repo = new OrganisationRepository(mockSql);

    await repo.acquireBootstrapLock("acc_test");
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
      "organisation-bootstrap:acc_test",
    ]);
  });

  it("DivisionRepository queries entry counts", async () => {
    const mockSql = createMockSql([{ count: "16" }]);
    const repo = new DivisionRepository(mockSql);

    const count = await repo.getEntryCount("div_456");
    expect(count).toBe(16);
  });

  it("SetupRepository queries by competition ID with locking", async () => {
    const mockSql = createMockSql([{ id: "setup_1", competition_id: "cmp_1", revision: 2 }]);
    const repo = new SetupRepository(mockSql);

    const draft = await repo.findByCompetitionId("cmp_1", "for_update");
    expect(draft).toEqual({ id: "setup_1", competition_id: "cmp_1", revision: 2 });
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE OF d"), ["cmp_1"]);
  });

  it("FormatRepository finds published revisions", async () => {
    const mockSql = createMockSql([{ id: "fmt_1", division_id: "div_1", status: "published" }]);
    const repo = new FormatRepository(mockSql);

    const fmt = await repo.findPublishedByDivisionId("div_1");
    expect(fmt?.status).toBe("published");
  });

  it("ScheduleRepository acquires schedule mutation advisory lock", async () => {
    const mockSql = createMockSql([]);
    const repo = new ScheduleRepository(mockSql);

    await repo.acquireScheduleLock("cmp_789");
    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
      "schedule-mutation:cmp_789",
    ]);
  });
});

describe("V2 Architecture: Command Handlers", () => {
  it("CreateCompetitionHandler creates competition when slug is free", async () => {
    const mockSql = createMockSql([{ exists: false }]);
    const repo = new CompetitionRepository(mockSql);
    const handler = new CreateCompetitionHandler(repo);

    const command = new CreateCompetitionCommand({
      organisationId: "org_1",
      name: "Championship 2026",
      slug: "championship-2026",
      sportCode: "basketball",
      sportPackVersion: "1.0.0",
    });

    const result = await handler.execute(command);
    expect(result.slug).toBe("championship-2026");
    expect(result.id).toBeDefined();
  });

  it("CreateCompetitionHandler rejects duplicate slugs with ApiError 409", async () => {
    const mockSql = createMockSql([{ exists: true }]);
    const repo = new CompetitionRepository(mockSql);
    const handler = new CreateCompetitionHandler(repo);

    const command = new CreateCompetitionCommand({
      organisationId: "org_1",
      name: "Existing Comp",
      slug: "existing-slug",
      sportCode: "basketball",
      sportPackVersion: "1.0.0",
    });

    await expect(handler.execute(command)).rejects.toThrow(ApiError);
  });
});
