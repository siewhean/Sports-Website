import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGateDEvidence } from "./validate-gate-d-evidence.mjs";

describe("Gate D Evidence Ledger Validation", () => {
  it("validates existing QA-010 and QA-011 workload receipts", async () => {
    const summary = await validateGateDEvidence();
    assert.equal(summary.valid, true, "Expected Gate D evidence receipts to be valid");
    assert.ok(summary.passed >= 2, "Expected at least 2 valid receipts");
  });

  it("fails closed on invalid SHA pattern", async () => {
    await assert.rejects(async () => {
      await validateGateDEvidence("invalid-sha-123");
    }, /Invalid expected candidate SHA/);
  });
});
