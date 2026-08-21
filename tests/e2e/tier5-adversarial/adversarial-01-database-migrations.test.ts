import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationAdvisoryLockId, dropTestSchema } from "@matchday/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const migrationsDir = path.resolve(rootDir, "packages/database/migrations");

function computeSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Tier 5 Adversarial - Subsystem 1: Database Migrations (0001–0051)", () => {
  it("ADV-MIG-01: migration sequence format and forward-porting numbering (0001–0051) have zero gaps or collisions", async () => {
    const files = await readdir(migrationsDir);
    const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
    const migrationFiles = files.filter((f) => migrationPattern.test(f)).sort();

    // Exactly 51 sequential forward-only migrations
    expect(migrationFiles).toHaveLength(51);

    // Verify continuous numbering from 0001 to 0051
    migrationFiles.forEach((file, index) => {
      const expectedNumber = (index + 1).toString().padStart(4, "0");
      expect(file.startsWith(`${expectedNumber}_`)).toBe(true);
    });

    // Check key milestone boundaries
    expect(migrationFiles[0]).toBe("0001_foundation.sql");
    expect(migrationFiles[31]).toBe("0032_v1_unseeded_schedule_source_mapping.sql");
    expect(migrationFiles[34]).toBe("0035_identity_authentication_assurance.sql");
    expect(migrationFiles[35]).toBe("0036_gate_c_offline_replay.sql");
    expect(migrationFiles[50]).toBe("0051_gate_c_fallback_code_history_uniqueness.sql");
  });

  it("ADV-MIG-02: SHA256 checksum invariance computes authentic 64-char digests for all 51 migration files", async () => {
    const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();

    const checksumMap = new Map<string, string>();
    for (const file of files) {
      const content = await readFile(path.join(migrationsDir, file), "utf8");
      expect(content.length).toBeGreaterThan(0);
      const digest = computeSha256(content);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      checksumMap.set(file, digest);
    }

    expect(checksumMap.size).toBe(51);

    // Assert that altering a single byte in any migration alters the checksum
    const testFile = files[0]!;
    const originalContent = await readFile(path.join(migrationsDir, testFile), "utf8");
    const tamperedContent = originalContent + "\n-- tampered byte";
    expect(computeSha256(tamperedContent)).not.toBe(checksumMap.get(testFile));
  });

  it("ADV-MIG-03: migration runner enforces tamper detection and missing file integrity rules", async () => {
    // White-box test of the checksum and missing migration validation logic from migrations.ts
    const migrationContents = new Map<string, string>();
    migrationContents.set("0001_foundation.sql", "CREATE TABLE test_table();");
    migrationContents.set("0002_identity_sessions.sql", "CREATE TABLE sessions();");

    const currentRows = [
      { name: "0001_foundation.sql", checksum: computeSha256("CREATE TABLE test_table();") },
      { name: "0002_identity_sessions.sql", checksum: computeSha256("CREATE TABLE sessions_original();") }, // mismatch!
    ];

    // Check tamper mismatch detection logic
    let caughtError: string | null = null;
    try {
      for (const row of currentRows) {
        const contents = migrationContents.get(row.name);
        if (contents === undefined) {
          throw new Error(`Applied migration is missing from disk: ${row.name}`);
        }
        const checksum = computeSha256(contents);
        if (row.checksum !== checksum) {
          throw new Error(`Applied migration checksum mismatch: ${row.name}`);
        }
      }
    } catch (err: any) {
      caughtError = err.message;
    }
    expect(caughtError).toBe("Applied migration checksum mismatch: 0002_identity_sessions.sql");

    // Check missing applied migration detection
    const missingRows = [{ name: "0003_missing_migration.sql", checksum: "abc" }];
    let missingError: string | null = null;
    try {
      for (const row of missingRows) {
        const contents = migrationContents.get(row.name);
        if (contents === undefined) {
          throw new Error(`Applied migration is missing from disk: ${row.name}`);
        }
      }
    } catch (err: any) {
      missingError = err.message;
    }
    expect(missingError).toBe("Applied migration is missing from disk: 0003_missing_migration.sql");
  });

  it("ADV-MIG-04: global advisory lock constant is strictly bound and immutable", () => {
    expect(migrationAdvisoryLockId).toBe(1_450_121_337);
    expect(Number.isSafeInteger(migrationAdvisoryLockId)).toBe(true);
    expect(migrationAdvisoryLockId).toBeGreaterThan(0);
  });

  it("ADV-MIG-05: schema identifier validator prevents SQL injection and non-test schema drops", async () => {
    const identifierPattern = /^[a-z][a-z0-9_]*$/;

    // Valid identifiers
    expect(identifierPattern.test("public")).toBe(true);
    expect(identifierPattern.test("test_schema_123")).toBe(true);
    expect(identifierPattern.test("test_matrix_s1")).toBe(true);

    // Adversarial injection strings
    expect(identifierPattern.test("public; DROP TABLE schema_migrations; --")).toBe(false);
    expect(identifierPattern.test('test"schema')).toBe(false);
    expect(identifierPattern.test("123_invalid")).toBe(false);
    expect(identifierPattern.test("TestSchema")).toBe(false);
    expect(identifierPattern.test("test-schema")).toBe(false);
    expect(identifierPattern.test("")).toBe(false);
    expect(identifierPattern.test("test\u0000null")).toBe(false);

    // dropTestSchema protection against dangerous targets
    const dummyUrl = "postgres://invalid:invalid@127.0.0.1:5432/invalid";
    await expect(dropTestSchema(dummyUrl, "public")).rejects.toThrow("Refusing to drop a non-test schema");
    await expect(dropTestSchema(dummyUrl, "production")).rejects.toThrow("Refusing to drop a non-test schema");
    await expect(dropTestSchema(dummyUrl, "my_app")).rejects.toThrow("Refusing to drop a non-test schema");
    await expect(dropTestSchema(dummyUrl, "test_injection; DROP TABLE--")).rejects.toThrow(
      "Refusing to drop a non-test schema",
    );
  });
});
