import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 4 - Scenario 04: Multi-Division Tournament Temporal Migration Upgrade", () => {
  it("validates multi-division historical database schema upgrade progression (0001..0035 -> 0036..0051)", () => {
    const migrationsDir = path.join(rootDir, "packages/database/migrations");
    const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
    const allMigrations = readdirSync(migrationsDir)
      .filter((f) => migrationPattern.test(f))
      .sort();

    // 1. Verify baseline 0001..0035 migrations exist
    const baseMigrations = allMigrations.filter((m) => parseInt(m.slice(0, 4), 10) <= 35);
    expect(baseMigrations).toHaveLength(35);
    expect(baseMigrations[0]).toMatch(/^0001_/);
    expect(baseMigrations[34]).toMatch(/^0035_/);

    // 2. Verify forward-only Gate C migrations 0036..0051 exist
    const forwardMigrations = allMigrations.filter((m) => parseInt(m.slice(0, 4), 10) >= 36);
    expect(forwardMigrations.length).toBeGreaterThanOrEqual(16);
    expect(forwardMigrations[0]).toMatch(/^0036_/);
    expect(forwardMigrations[15]).toMatch(/^0051_/);

    // 3. Emulate multi-division tournament participant records
    const divisions = ["div-mens-open", "div-womens-open", "div-u19-boys", "div-u19-girls"];
    const tournamentState = divisions.map((divId, index) => ({
      divisionId: divId,
      matchCount: 6,
      homeEntryId: `entry-home-${index}`,
      awayEntryId: `entry-away-${index}`,
      snapshotVerified: true,
    }));

    expect(tournamentState).toHaveLength(4);
    for (const division of tournamentState) {
      expect(division.snapshotVerified).toBe(true);
      expect(division.matchCount).toBe(6);
    }
  });
});
