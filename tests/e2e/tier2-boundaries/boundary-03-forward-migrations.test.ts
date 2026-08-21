import { describe, it, expect } from "vitest";
import { computeSha256, isValidSha256 } from "../helpers/test-utils";

describe("Tier 2 - Boundary 03: Forward Migration Filename & Checksum Bounds", () => {
  const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

  it("B03-T01: migrationPattern rejects 3-digit prefixes, 5-digit prefixes, and empty strings", () => {
    expect(migrationPattern.test("001_initial.sql")).toBe(false);
    expect(migrationPattern.test("00001_initial.sql")).toBe(false);
    expect(migrationPattern.test("")).toBe(false);
    expect(migrationPattern.test("0001_valid_name.sql")).toBe(true);
  });

  it("B03-T02: migrationPattern rejects uppercase letters, dashes, and special characters in migration names", () => {
    expect(migrationPattern.test("0036_Gate_C_Offline.sql")).toBe(false);
    expect(migrationPattern.test("0036_gate-c-offline.sql")).toBe(false);
    expect(migrationPattern.test("0036_gate_c_offline$.sql")).toBe(false);
    expect(migrationPattern.test("0036_gate_c_offline.sql")).toBe(true);
  });

  it("B03-T03: checksum calculation on empty string produces standard SHA256 empty digest e3b0c442...", () => {
    const emptySha = computeSha256("");
    expect(emptySha).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(isValidSha256(emptySha)).toBe(true);
  });

  it("B03-T04: isValidSha256 rejects truncated digests (<64 chars) and digests with uppercase or non-hex chars", () => {
    expect(isValidSha256("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85")).toBe(false); // 63 chars
    expect(isValidSha256("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855")).toBe(false); // uppercase
    expect(isValidSha256("g".repeat(64))).toBe(false); // non-hex
    expect(isValidSha256("a".repeat(64))).toBe(true);
  });

  it("B03-T05: detects 1-byte delta in migration contents causing SHA256 checksum divergence", () => {
    const contentA = "CREATE TABLE users (id uuid PRIMARY KEY);";
    const contentB = "CREATE TABLE users (id uuid PRIMARY KEY);\n";
    const hashA = computeSha256(contentA);
    const hashB = computeSha256(contentB);

    expect(hashA).not.toBe(hashB);
    expect(hashA).toHaveLength(64);
    expect(hashB).toHaveLength(64);
  });
});
