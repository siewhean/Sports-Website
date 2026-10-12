import { describe, expect, it } from "vitest";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";
import { RepairRepository } from "../../src/repositories/repair.repository.js";
import type { SqlExecutor } from "../../src/repositories/types.js";

type MockPhase4DelayInstance = {
  transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
  competitionAccess: () => Promise<{ id: string; organisation_id: string; status: string }>;
  lockIdempotency: () => Promise<void>;
  lockScheduleMutation: () => Promise<void>;
  evidence: () => Promise<void>;
  revisionDetail: (
    _tx: SqlExecutor,
    id: string,
  ) => Promise<{ id: string; competition_id: string; revision: number; status: string }>;
  delayScheduleMatches: typeof Phase4Runtime.prototype.delayScheduleMatches;
};

describe("Phase 4 Schedule Delay Mutation (Track R2)", () => {
  it("delays unstarted matches and preserves finished matches", async () => {
    const parentRevisionId = "rev-1";
    const competitionId = "comp-1";
    const match1 = "match-unstarted";
    const match2 = "match-finished";
    const areaId = "area-1";
    const targetAreaId = "area-2";

    const executedSql: string[] = [];
    const insertedMatches: Array<{
      match_id: string;
      playing_area_id: string;
      start_ms: number;
      end_ms: number;
    }> = [];

    const mockTx = {
      unsafe: async (query: string, params: unknown[] = []) => {
        executedSql.push(query);
        if (query.includes("FROM schedule_revisions WHERE id=$1")) {
          return [
            {
              id: parentRevisionId,
              competition_id: competitionId,
              revision: 1,
              source_job_id: null,
              input_hash: "a".repeat(64),
              status: "published",
              quality: {},
            },
          ];
        }
        if (query.includes("phase4_sha256_json")) {
          return [{ hash: "req-hash-123" }];
        }
        if (query.includes("FROM phase4_mutation_receipts")) {
          return [];
        }
        if (query.includes("FROM playing_areas WHERE id=$1")) {
          return [{ id: targetAreaId }];
        }
        if (query.includes("FROM scheduled_matches sm")) {
          return [
            {
              match_id: match1,
              playing_area_id: areaId,
              starts_at: new Date("2027-04-01T10:00:00.000Z"),
              ends_at: new Date("2027-04-01T11:00:00.000Z"),
              state: "ready",
            },
            {
              match_id: match2,
              playing_area_id: areaId,
              starts_at: new Date("2027-04-01T09:00:00.000Z"),
              ends_at: new Date("2027-04-01T10:00:00.000Z"),
              state: "final",
            },
          ];
        }
        if (query.includes("SELECT COALESCE(max(revision),0)::int+1")) {
          return [{ revision: 2 }];
        }
        if (query.includes("FROM schedule_revision_formats WHERE schedule_revision_id=$1")) {
          return [{ format_revision_id: "format-1" }];
        }
        if (query.includes("INSERT INTO scheduled_matches")) {
          insertedMatches.push({
            match_id: params[1] as string,
            playing_area_id: params[3] as string,
            start_ms: params[4] as number,
            end_ms: params[5] as number,
          });
          return [];
        }
        return [];
      },
    };

    const instance = Object.create(Phase4Runtime.prototype) as MockPhase4DelayInstance;
    instance.transaction = async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
      fn(mockTx as unknown as SqlExecutor);
    instance.competitionAccess = async () => ({ id: competitionId, organisation_id: "org-1", status: "active" });
    instance.lockIdempotency = async () => undefined;
    instance.lockScheduleMutation = async () => undefined;
    instance.evidence = async () => undefined;
    instance.revisionDetail = async (_tx: SqlExecutor, id: string) => ({
      id,
      competition_id: competitionId,
      revision: 2,
      status: "ready_for_review",
    });

    const result = await instance.delayScheduleMatches(
      { accountId: "acc-1" },
      parentRevisionId,
      {
        idempotency_key: "idem-1",
        expected_revision: 1,
        delay_minutes: 30,
        playing_area_id: areaId,
        target_playing_area_id: targetAreaId,
      },
      "req-1",
    );

    expect(result.revision).toBe(2);
    expect(result.delayed_count).toBe(1);

    // Verify unstarted match shifted by 30 mins (1,800,000 ms) and area reassigned
    const unstarted = insertedMatches.find((m) => m.match_id === match1);
    expect(unstarted).toBeDefined();
    expect(unstarted?.playing_area_id).toBe(targetAreaId);
    expect(unstarted?.start_ms).toBe(new Date("2027-04-01T10:30:00.000Z").getTime());
    expect(unstarted?.end_ms).toBe(new Date("2027-04-01T11:30:00.000Z").getTime());

    // Verify finished match was untouched
    const finished = insertedMatches.find((m) => m.match_id === match2);
    expect(finished).toBeDefined();
    expect(finished?.playing_area_id).toBe(areaId);
    expect(finished?.start_ms).toBe(new Date("2027-04-01T09:00:00.000Z").getTime());
  });

  it("rejects invalid delay inputs", async () => {
    const instance = Object.create(Phase4Runtime.prototype) as MockPhase4DelayInstance;
    instance.transaction = async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
      fn({
        unsafe: async (query: string) => {
          if (query.includes("FROM schedule_revisions WHERE id=$1")) {
            return [{ id: "rev-1", competition_id: "comp-1", revision: 1, status: "published" }];
          }
          if (query.includes("phase4_sha256_json")) return [{ hash: "hash" }];
          if (query.includes("FROM phase4_mutation_receipts")) return [];
          return [];
        },
      } as unknown as SqlExecutor);
    instance.competitionAccess = async () => ({ id: "comp-1", organisation_id: "org-1", status: "active" });
    instance.lockIdempotency = async () => undefined;
    instance.lockScheduleMutation = async () => undefined;

    await expect(
      instance.delayScheduleMatches(
        { accountId: "acc-1" },
        "rev-1",
        { idempotency_key: "k", expected_revision: 1, delay_minutes: -5 },
        "req-1",
      ),
    ).rejects.toThrow("Delay minutes must be between 0 and 720");

    await expect(
      instance.delayScheduleMatches(
        { accountId: "acc-1" },
        "rev-1",
        { idempotency_key: "k", expected_revision: 1, delay_minutes: 0 },
        "req-1",
      ),
    ).rejects.toThrow("Either delay_minutes > 0 or target_playing_area_id must be provided");
  });
});

describe("Repair Repository Hygiene (Track R2)", () => {
  it("reconciles stale pending cases when a newer result version arrives", async () => {
    const executed: Array<{ query: string; params: unknown[] }> = [];
    const mockSql = {
      unsafe: async (query: string, params: unknown[] = []) => {
        executed.push({ query, params });
        return [];
      },
    };

    const repo = new RepairRepository(mockSql as unknown as SqlExecutor);
    await repo.reconcileStaleCases("comp-1");

    expect(executed.length).toBe(1);
    expect(executed[0]?.query).toContain("INSERT INTO result_repair_case_events");
    expect(executed[0]?.query).toContain("'superseded'");
    expect(executed[0]?.query).toContain("newer_case.source_result_version > older_case.source_result_version");
    expect(executed[0]?.params).toEqual(["comp-1"]);
  });
});
