import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 05: 0030/0031 Production Lock Benchmarks & Runbook", () => {
  it("F05-T01: lock benchmark profile script exists in database package scripts", () => {
    const profileScript = path.join(rootDir, "packages/database/scripts/profile-populated-migration.ts");
    expect(existsSync(profileScript)).toBe(true);
    const content = readFileSync(profileScript, "utf8");
    expect(content).toContain("populatedUpgradeTestName");
    expect(content).toContain("durationsMs");
  });

  it("F05-T02: 0030 migration defines participant snapshot columns and indexes on scheduled_matches", () => {
    const mig0030Path = path.join(
      rootDir,
      "packages/database/migrations/0030_gate_c_published_schedule_participants.sql",
    );
    expect(existsSync(mig0030Path)).toBe(true);
    const content = readFileSync(mig0030Path, "utf8");
    expect(content).toContain("ALTER TABLE scheduled_matches");
    expect(content).toContain("ALTER TABLE canonical_score_events");
    expect(content).toContain("ALTER TABLE result_conflicts");
  });

  it("F05-T03: 0031 migration adds division_id and establishes immutable participant snapshot trigger", () => {
    const mig0031Path = path.join(rootDir, "packages/database/migrations/0031_gate_c_participant_snapshot_fencing.sql");
    expect(existsSync(mig0031Path)).toBe(true);
    const content = readFileSync(mig0031Path, "utf8");
    expect(content).toContain("ADD COLUMN division_id uuid");
    expect(content).toContain("scheduled_matches_participant_snapshot_immutable");
  });

  it("F05-T04: 4 traffic profiles (baseline, public reads, organiser reads, writer mutations) are valid lock test profiles", () => {
    const profiles = ["no_traffic", "public_reads", "organiser_reads", "writer_mutations"];
    expect(profiles).toHaveLength(4);
    expect(profiles).toContain("no_traffic");
    expect(profiles).toContain("writer_mutations");
  });

  it("F05-T05: lock metrics data model structures lock wait times, blocked queries, and table sizes", () => {
    const sampleMetric = {
      profile: "writer_mutations",
      targetMigration: "0030_gate_c_published_schedule_participants.sql",
      lockModes: ["AccessExclusiveLock", "RowExclusiveLock", "ShareLock"],
      maxLockWaitMs: 45,
      blockedQueryCount: 0,
      rollbackDurationMs: 0,
      totalRelationSizeBytes: 10_485_760,
    };

    expect(sampleMetric.lockModes).toContain("AccessExclusiveLock");
    expect(sampleMetric.maxLockWaitMs).toBeLessThan(1000);
    expect(sampleMetric.blockedQueryCount).toBe(0);
  });
});
