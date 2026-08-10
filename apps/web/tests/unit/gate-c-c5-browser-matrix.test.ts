import path from "node:path";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import { describe, expect, it, vi } from "vitest";
import { GATE_C_C5_PROJECT_NAMES, resolveGateCC5BrowserEvidence } from "../helpers/gate-c-c5-browser-matrix";
import GateCC5StrictReporter from "../helpers/gate-c-c5-strict-reporter";

describe("Gate C C5 browser matrix", () => {
  it("contains exactly the six approved browser and device projects", () => {
    expect(GATE_C_C5_PROJECT_NAMES).toEqual([
      "desktop-chromium",
      "desktop-firefox",
      "desktop-webkit",
      "phone-chromium",
      "phone-webkit",
      "tablet-webkit",
    ]);
  });

  it("binds browser artifacts and the JSON report beneath the exact source SHA", () => {
    const sourceSha = "fec90ae50c8c7eb701d4645a35d5977034b8b7cc";
    const resolved = resolveGateCC5BrowserEvidence({ evidenceDirectory: "/tmp/c5-run-1", sourceSha });
    expect(resolved.runDirectory).toBe(path.join("/tmp/c5-run-1", sourceSha, "browser-matrix"));
    expect(resolved.outputDirectory).toBe(path.join(resolved.runDirectory, "artifacts"));
    expect(resolved.jsonReport).toBe(path.join(resolved.runDirectory, "playwright-results.json"));
  });

  it.each([
    { evidenceDirectory: "/tmp/c5", sourceSha: undefined },
    { evidenceDirectory: "/tmp/c5", sourceSha: "fec90ae" },
    { evidenceDirectory: "/tmp/c5", sourceSha: "FEC90AE50C8C7EB701D4645A35D5977034B8B7CC" },
    { evidenceDirectory: undefined, sourceSha: "fec90ae50c8c7eb701d4645a35d5977034b8b7cc" },
  ])("fails closed for incomplete evidence binding: %o", (input) => {
    expect(() => resolveGateCC5BrowserEvidence(input)).toThrow();
  });

  it("turns any Playwright skip into a failed C5 result", async () => {
    const reporter = new GateCC5StrictReporter();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const testCase = {
      parent: { project: () => ({ name: "phone-webkit" }) },
      titlePath: () => ["C5 matrix", "service worker"],
    } as unknown as TestCase;
    reporter.onTestEnd(testCase, { status: "skipped" } as TestResult);

    await expect(reporter.onEnd()).resolves.toEqual({ status: "failed" });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("phone-webkit"));
    stderr.mockRestore();
  });
});
