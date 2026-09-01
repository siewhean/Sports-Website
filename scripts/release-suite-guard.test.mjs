import { describe, expect, it } from "vitest";
import { parseNonzeroTestCount, VALID_PHASES } from "./release-suite-guard.mjs";

describe("release-suite-guard — Nonzero-Test & Configuration Protection", () => {
  it("recognises only valid release phases", () => {
    expect(VALID_PHASES.has("A")).toBe(true);
    expect(VALID_PHASES.has("B")).toBe(true);
    expect(VALID_PHASES.has("C")).toBe(true);
    expect(VALID_PHASES.has("ALL")).toBe(true);
    expect(VALID_PHASES.has("INVALID")).toBe(false);
  });

  describe("parseNonzeroTestCount regex parser", () => {
    it("extracts test counts from Vitest runner output", () => {
      const vitestOutput = `
      Test Files  57 passed (57)
           Tests  264 passed (264)
        Start at  13:20:39
      `;
      expect(parseNonzeroTestCount(vitestOutput)).toBe(264);
    });

    it("extracts test counts from Node.js --test runner output", () => {
      const nodeTestOutput = `
      ℹ tests 19
      ℹ pass 19
      ℹ fail 0
      `;
      expect(parseNonzeroTestCount(nodeTestOutput)).toBe(19);
    });

    it("extracts test counts from Playwright runner output", () => {
      const playwrightOutput = `
      Running 12 tests using 4 workers
      12 passed (4.2s)
      `;
      expect(parseNonzeroTestCount(playwrightOutput)).toBe(12);
    });

    it("returns 0 when no tests ran or output is empty / failed closed", () => {
      expect(parseNonzeroTestCount("")).toBe(0);
      expect(parseNonzeroTestCount("No tests found")).toBe(0);
      expect(parseNonzeroTestCount("Vitest ran 0 tests")).toBe(0);
    });

    it("accepts known positive validation script signals", () => {
      expect(parseNonzeroTestCount("Validated 5 size oracles")).toBe(1);
      expect(parseNonzeroTestCount("Generated OpenAPI contract is current and valid JSON.")).toBe(1);
      expect(parseNonzeroTestCount("1:08PM INF no leaks found")).toBe(1);
    });
  });
});
