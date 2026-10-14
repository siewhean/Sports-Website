import { describe, expect, it } from "vitest";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";

describe("R4.1 honest AI baseline: stub provider scope and provenance (AI-007..009 retired to manual_fallback)", () => {
  const stub = new DeterministicPhase4AiStub();

  it("R4.1: stub does not implement modifyFormat, preventing canned format changes", () => {
    expect((stub as unknown as Record<string, unknown>).modifyFormat).toBeUndefined();
  });

  it("R4.1: stub does not implement suggestSchedulePreferences, preventing canned preferences", () => {
    expect((stub as unknown as Record<string, unknown>).suggestSchedulePreferences).toBeUndefined();
  });

  it("R4.1: stub does not implement recommendRepairActions, preventing canned repair actions", () => {
    expect((stub as unknown as Record<string, unknown>).recommendRepairActions).toBeUndefined();
  });

  it("AI-016 & AI-017: enforces strict provenance tracking and cost/latency metrics", async () => {
    const briefResponse = await stub.generateCompetitionBrief({
      action: "text_to_brief",
      schemaVersion: "1.0",
      locale: "en-GB",
      instruction: "Generate competition brief from organiser text",
      organiserText:
        'We want a basketball tournament called "Summer Slam" at City Arena with 8 teams across 2 divisions starting 2026-08-01 to 2026-08-03 with 2 courts and 30 minute slots',
    });

    expect(briefResponse.data.sport).toBe("basketball");
    expect(briefResponse.data.name).toBe("Summer Slam");
    expect(briefResponse.data.entry_count).toBe(8);
    expect(briefResponse.data.division_count).toBe(2);
    expect(briefResponse.providerRequestId).toBe("phase4-deterministic-stub-v1");
    expect(briefResponse.promptTemplateVersion).toBe("1.0.0");
    expect(briefResponse.modelIdentifier).toBe("deterministic-stub-v1");
    expect(briefResponse.promptTokens).toBeGreaterThan(0);
    expect(briefResponse.completionTokens).toBeGreaterThan(0);
    expect(briefResponse.latencyMs).toBeGreaterThanOrEqual(0);
    expect(briefResponse.estimatedCostUsd).toBeGreaterThan(0);
  });
});
