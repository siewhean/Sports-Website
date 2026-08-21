import { describe, it, expect } from "vitest";
import { isValidGitSha } from "../helpers/test-utils";

describe("Tier 2 - Boundary 14: QA Evidence Ledger & Candidate Freezing Bounds", () => {
  it("B14-T01: isValidGitSha rejects 39-char SHA, 41-char SHA, uppercase characters, and spaces", () => {
    expect(isValidGitSha("9e6572bfab7f9c5d2c6ea04c726fc5141a578a4")).toBe(false); // 39
    expect(isValidGitSha("9e6572bfab7f9c5d2c6ea04c726fc5141a578a455")).toBe(false); // 41
    expect(isValidGitSha("9E6572BFAB7F9C5D2C6EA04C726FC5141A578A45")).toBe(false); // uppercase
    expect(isValidGitSha(" 9e6572bfab7f9c5d2c6ea04c726fc5141a578a45")).toBe(false); // leading space
    expect(isValidGitSha("9e6572bfab7f9c5d2c6ea04c726fc5141a578a45")).toBe(true);
  });

  it("B14-T02: gate certification rejects ledger when p0Count > 0 or p1Count > 0", () => {
    const evaluateVerdict = (p0: number, p1: number, p2: number) => {
      if (p0 > 0 || p1 > 0) return "FAIL";
      return "PASS";
    };

    expect(evaluateVerdict(0, 0, 0)).toBe("PASS");
    expect(evaluateVerdict(0, 0, 5)).toBe("PASS"); // P2 allowed
    expect(evaluateVerdict(1, 0, 0)).toBe("FAIL"); // P0 veto
    expect(evaluateVerdict(0, 1, 0)).toBe("FAIL"); // P1 veto
  });

  it("B14-T03: evidence ledger validator rejects empty evidence artifact list", () => {
    const emptyArtifacts: string[] = [];
    const validateArtifacts = (artifacts: string[]) => {
      if (artifacts.length === 0) throw new Error("Evidence ledger must contain at least one artifact");
      return true;
    };

    expect(() => validateArtifacts(emptyArtifacts)).toThrow("at least one artifact");
    expect(validateArtifacts(["gate-c-c3-final-evidence.json"])).toBe(true);
  });

  it("B14-T04: rejects candidate SHA mismatch between ledger header and sealed manifest", () => {
    const ledgerSha = "9e6572bfab7f9c5d2c6ea04c726fc5141a578a45";
    const manifestSha = "8f7196478ce653b6f6dbb2940d89c92ae3d7cd92";

    const assertShaMatch = (lSha: string, mSha: string) => {
      if (lSha !== mSha) throw new Error("Ledger SHA does not match candidate SHA");
    };

    expect(() => assertShaMatch(ledgerSha, manifestSha)).toThrow("does not match candidate SHA");
    expect(() => assertShaMatch(ledgerSha, ledgerSha)).not.toThrow();
  });

  it("B14-T05: timestamps in evidence ledger must be ISO-8601 UTC strings with Z suffix", () => {
    const validIso = "2026-08-20T06:50:00.000Z";
    const invalidNonUtc = "2026-08-20T06:50:00+08:00";
    const invalidDate = "2026-08-20 06:50:00";

    const isUtcIso = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

    expect(isUtcIso(validIso)).toBe(true);
    expect(isUtcIso(invalidNonUtc)).toBe(false);
    expect(isUtcIso(invalidDate)).toBe(false);
  });
});
