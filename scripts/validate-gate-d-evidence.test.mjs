import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGateDEvidence } from "./validate-gate-d-evidence.mjs";

describe("Gate D Evidence Ledger Validation", () => {
  it("fails closed when expected candidate SHA is missing or malformed", async () => {
    await assert.rejects(async () => {
      await validateGateDEvidence(undefined);
    }, /requires a valid 40-character candidate SHA/);

    await assert.rejects(async () => {
      await validateGateDEvidence("short-sha");
    }, /requires a valid 40-character candidate SHA/);
  });

  it("fails closed on component diagnostic evidence or SHA mismatch", async () => {
    const dummySha = "0123456789abcdef0123456789abcdef01234567";
    const summary = await validateGateDEvidence(dummySha);
    // If receipts are currently component receipts or mismatch SHA, summary must report valid: false
    assert.equal(summary.valid, false);
    assert.ok(summary.failed.length > 0);
  });
});
