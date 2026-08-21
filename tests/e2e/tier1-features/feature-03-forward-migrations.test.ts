import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSha256, isValidSha256 } from "../helpers/test-utils";
import { migrationAdvisoryLockId } from "../../../packages/database/src/migrations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 03: Forward-Only Database Migrations (0036–0051)", () => {
  const migrationsDir = path.join(rootDir, "packages/database/migrations");
  const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

  it("F03-T01: all migration filenames strictly adhere to ^\\d{4}_[a-z0-9_]+\\.sql$ pattern", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThanOrEqual(51);
    for (const file of files) {
      expect(file).toMatch(migrationPattern);
    }
  });

  it("F03-T02: Gate C forward-only migrations are sequenced strictly from 0036 to 0051 with no duplicate prefixes", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => migrationPattern.test(f))
      .sort();

    const prefixes = files.map((f) => f.slice(0, 4));
    const prefixSet = new Set(prefixes);
    // Every prefix must be strictly unique
    expect(prefixSet.size).toBe(files.length);

    // Verify 0036 to 0051 exist in exact order
    const gateCPrefixes = prefixes.filter((p) => parseInt(p, 10) >= 36);
    expect(gateCPrefixes.length).toBeGreaterThanOrEqual(16);
    for (let i = 36; i <= 51; i++) {
      const expected = String(i).padStart(4, "0");
      expect(prefixes).toContain(expected);
    }
  });

  it("F03-T03: database advisory lock constant is exactly 1450121337", () => {
    expect(migrationAdvisoryLockId).toBe(1_450_121_337);
  });

  it("F03-T04: SHA256 checksum generation for migration contents produces valid 64-character hex digest", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => migrationPattern.test(f))
      .sort();

    const firstFile = files[0]!;
    const contents = readFileSync(path.join(migrationsDir, firstFile), "utf8");
    const checksum = computeSha256(contents);

    expect(isValidSha256(checksum)).toBe(true);
    expect(checksum.length).toBe(64);
  });

  it("F03-T05: forward-only migrations define critical Gate C schemas (replay, repair, HMAC, fallback)", () => {
    const files = readdirSync(migrationsDir).filter((f) => migrationPattern.test(f));

    const offlineReplay = files.find((f) => f.startsWith("0036_"));
    expect(offlineReplay).toBeDefined();
    expect(offlineReplay).toContain("offline_replay");

    const repairProjections = files.find((f) => f.startsWith("0037_"));
    expect(repairProjections).toBeDefined();
    expect(repairProjections).toContain("repair");

    const hmacKeys = files.find((f) => f.startsWith("0047_"));
    expect(hmacKeys).toBeDefined();
    expect(hmacKeys).toContain("hmac");

    const fallbackUniqueness = files.find((f) => f.startsWith("0051_"));
    expect(fallbackUniqueness).toBeDefined();
    expect(fallbackUniqueness).toContain("fallback");
  });
});
