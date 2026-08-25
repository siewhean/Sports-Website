import { describe, expect, it } from "vitest";
import { DeterministicPhase4AiStub } from "../../src/phase-4-ai-provider.js";

describe("Phase 4 AI Workflows (AI-007, AI-008, AI-009)", () => {
  const stub = new DeterministicPhase4AiStub();

  it("AI-007: modifies format proposals with provenance and valid schema", async () => {
    const mockDocument = {
      schemaVersion: 1,
      graph: { schemaVersion: 1, stages: [], matches: [] },
      layout: { schemaVersion: 1, stagePositions: [] },
    };
    const response = await stub.modifyFormat({
      organiserText: "Switch to double elimination format",
      currentDocument: mockDocument,
    });

    expect(response.proposedDocument).toBeDefined();
    expect(response.explanation).toContain("double elimination");
    expect(response.promptTemplateVersion).toBe("1.0.0");
    expect(response.modelIdentifier).toBe("deterministic-stub-v1");
    expect(response.promptTokens).toBeGreaterThan(0);
    expect(response.latencyMs).toBeDefined();
    expect(response.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("AI-008: extracts schedule preferences with provenance", async () => {
    const response = await stub.suggestSchedulePreferences({
      organiserText: "Ensure 30 minutes rest between matches and prefer evening matches",
    });

    expect(response.proposedPreferences).toMatchObject({
      minimum_rest_minutes: 30,
      prefer_evening: true,
    });
    expect(response.explanation).toContain("rest");
    expect(response.promptTemplateVersion).toBe("1.0.0");
    expect(response.modelIdentifier).toBe("deterministic-stub-v1");
    expect(response.promptTokens).toBeGreaterThan(0);
  });

  it("AI-009: generates repair action recommendations with provenance", async () => {
    const response = await stub.recommendRepairActions({
      organiserText: "Delay pitch 1 matches by 15 minutes due to rain",
      caseDetails: { caseId: "case-123" },
    });

    expect(response.recommendedActions).toHaveLength(1);
    expect(response.recommendedActions[0]).toMatchObject({
      action_type: "shift_match",
      shift_minutes: 15,
    });
    expect(response.promptTemplateVersion).toBe("1.0.0");
    expect(response.modelIdentifier).toBe("deterministic-stub-v1");
    expect(response.promptTokens).toBeGreaterThan(0);
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
