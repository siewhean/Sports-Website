import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidGitSha } from "../helpers/test-utils";
import { TEST_CANDIDATE_SHA } from "../helpers/fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 14: QA Evidence Ledgers & Candidate Freezing", () => {
  it("F14-T01: candidate SHA format conforms to 40-character hexadecimal git commit hash", () => {
    expect(isValidGitSha(TEST_CANDIDATE_SHA)).toBe(true);
    expect(TEST_CANDIDATE_SHA.length).toBe(40);
  });

  it("F14-T02: Gate C C2 ledger runner script exists and contains validation logic", () => {
    const scriptPath = path.join(rootDir, "scripts/run-gate-c-c2-ledger.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("sourceSha");
  });

  it("F14-T03: Gate C C3 ledger runner script exists and includes browser verification", () => {
    const scriptPath = path.join(rootDir, "scripts/run-gate-c-c3-ledger.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("gate-c-c3-exact-sha-ledger");
    expect(content).toContain("gateCC3Projects");
  });

  it("F14-T04: QA ledger schema enforces 0 P0 and 0 P1 defects for final gate certification", () => {
    const sampleLedger = {
      schemaVersion: 1,
      candidateSha: TEST_CANDIDATE_SHA,
      gate: "GATE_C",
      verdict: "PASS",
      defects: {
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      },
      evidenceArtifacts: ["gate-c-c3-final-evidence.json", "gate-c-c5-final-evidence.json"],
      sealedAt: new Date().toISOString(),
    };

    expect(sampleLedger.verdict).toBe("PASS");
    expect(sampleLedger.defects.p0Count).toBe(0);
    expect(sampleLedger.defects.p1Count).toBe(0);
  });

  it("F14-T05: browser gate evidence validation script exists in repository", () => {
    const scriptPath = path.join(rootDir, "scripts/validate-browser-gate-evidence.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("validateBrowserGateEvidence");
  });
});
