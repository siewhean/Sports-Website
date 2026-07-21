import { describe, expect, it } from "vitest";
import { createAiAuditMetadata, createAiRequestFingerprint, decideAiActionAccounting } from "../src/index.js";

describe("AI accounting and audit contracts", () => {
  it("charges only successful valid uncached actions", () => {
    expect(decideAiActionAccounting({ outcome: "success", cacheStatus: "miss", valid: true })).toEqual({
      charge: true,
      reason: "successful_uncached_action",
      units: 1,
    });
    expect(decideAiActionAccounting({ outcome: "success", cacheStatus: "hit", valid: true }).units).toBe(0);
    expect(decideAiActionAccounting({ outcome: "failure", cacheStatus: "miss", valid: false }).units).toBe(0);
    expect(
      decideAiActionAccounting({ outcome: "manual_fallback", cacheStatus: "not_checked", valid: false }).units,
    ).toBe(0);
    expect(decideAiActionAccounting({ outcome: "success", cacheStatus: "miss", valid: false }).units).toBe(0);
  });

  it("normalises identical request identity without storing source text", () => {
    const first = createAiRequestFingerprint({
      action: "text_to_brief",
      schemaVersion: "1.0",
      locale: "en-SG",
      text: "Private   organiser\nnotes",
    });
    const second = createAiRequestFingerprint({
      action: "text_to_brief",
      schemaVersion: "1.0",
      locale: "EN-sg",
      text: " Private organiser notes ",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    const audit = createAiAuditMetadata({
      action: "text_to_brief",
      text: "Private organiser notes",
      schemaVersion: "1.0",
      locale: "en-SG",
      outcome: "failure",
      cacheStatus: "miss",
      chargedUnits: 0,
      attempts: 3,
      durationMs: 42.4,
      failureCode: "provider_unavailable",
    });
    expect(JSON.stringify(audit)).not.toContain("Private");
    expect(audit).toMatchObject({ input_character_count: 23, attempts: 3, duration_ms: 42, charged_units: 0 });
  });
});
