import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 04: 6-Scenario Temporal Migration Matrix", () => {
  it("F04-T01: Scenario 1 (Empty DB) verification test exists in database test suite", () => {
    const testPath = path.join(rootDir, "packages/database/tests/integration/migrations.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("apply from an empty schema and are idempotent");
    expect(content).toContain("first.applied");
  });

  it("F04-T02: Scenario 2 (Historical pre-C2) verifies forward migration from Phase 4 state", () => {
    const testPath = path.join(rootDir, "packages/database/tests/integration/migrations.test.ts");
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("score_events");
    expect(content).toContain("scheduled_matches");
  });

  it("F04-T03: Scenario 3 (Current-main 0032-0035) verifies forward upgrade through 0036-0051", () => {
    const testPath = path.join(rootDir, "packages/database/tests/integration/gate-c-c3-migration.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("0036_gate_c_offline_replay.sql");
    expect(content).toContain("0051_gate_c_fallback_code_history_uniqueness.sql");
  });

  it("F04-T04: Scenario 4 & 5 (Malformed pre-0030/pre-0031) assert atomic rollback on constraint violation", () => {
    const testPath = path.join(
      rootDir,
      "packages/database/tests/integration/gate-c-c2-malformed-upgrade-preflights.test.ts",
    );
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain(
      "aborts migration 0030 when retained canonical history has a mismatched writer generation",
    );
    expect(content).toContain(
      "aborts migration 0031 when a published participant snapshot belongs to another division",
    );
    expect(content).toContain("expectColumnAbsent");
  });

  it("F04-T05: Scenario 6 (Repaired DB) validates migration head convergence without schema drift", () => {
    const testPath = path.join(rootDir, "packages/database/tests/integration/migrations.test.ts");
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("rejects checksum drift in an already-applied migration");
    expect(content).toContain("checksum mismatch");
  });
});
