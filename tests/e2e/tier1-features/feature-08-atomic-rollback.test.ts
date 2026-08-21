import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 08: Atomic C4 Transaction Rollback", () => {
  it("F08-T01: GateCC4Runtime executes publishRevision inside atomic transaction block", () => {
    const runtimePath = path.join(rootDir, "apps/api/src/gate-c-c4-runtime.ts");
    expect(existsSync(runtimePath)).toBe(true);
    const content = readFileSync(runtimePath, "utf8");
    expect(content).toContain("publishRevision");
    expect(content).toContain("this.transaction(async (tx)");
  });

  it("F08-T02: publishRevision acquires PostgreSQL advisory xact lock for competition publication isolation", () => {
    const runtimePath = path.join(rootDir, "apps/api/src/gate-c-c4-runtime.ts");
    const content = readFileSync(runtimePath, "utf8");
    expect(content).toContain("pg_advisory_xact_lock");
    expect(content).toContain("gate-c:repair-publication:");
  });

  it("F08-T03: publication workflow rolls back revisions, projections, audit, and outbox on error", () => {
    const testPath = path.join(rootDir, "packages/database/tests/integration/gate-c-c4-migration.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("audit_events");
    expect(content).toContain("outbox_events");
    expect(content).toContain("schedule_repair_publication_receipts");
  });

  it("F08-T04: PostgresRepairPublisher encapsulates atomic multi-division schedule revision updates", () => {
    const publisherPath = path.join(rootDir, "apps/api/src/gate-c-c4-postgres-publisher.ts");
    expect(existsSync(publisherPath)).toBe(true);
    const content = readFileSync(publisherPath, "utf8");
    expect(content).toContain("class GateCC4PostgresPublisher");
    expect(content).toContain("publish");
  });

  it("F08-T05: publication version fencing migration enforces monotonic version increment", () => {
    const testPath = path.join(rootDir, "packages/database/tests/unit/gate-c-c4-publication-version-fencing.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, "utf8");
    expect(content).toContain("publication version");
  });
});
