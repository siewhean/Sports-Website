import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapBriefToFormatRecommendationInput, mapBriefToSetupInput, validateCompetitionBrief } from "../src/index.js";

type EvaluationFixture = {
  schema_version: string;
  canonical_source: string;
  cases: Array<{
    id: string;
    organiser_text: string;
    available_match_slots: number | null;
    expected_brief: unknown;
  }>;
  adversarial_outputs: Array<{ id: string; value: unknown }>;
};

const evaluation = JSON.parse(
  readFileSync(new URL("../evaluation/phase-4-ai-evaluation.json", import.meta.url), "utf8"),
) as EvaluationFixture;
const canonical = JSON.parse(
  readFileSync(new URL("../../../validation/canonical-competitions.json", import.meta.url), "utf8"),
) as { competitions: Array<{ entry_count: number; capacity: { expected_slots: number } }> };

describe("Phase 4 canonical AI evaluation set", () => {
  it("is pinned to every canonical 8/12/16/24/48 competition", () => {
    const canonicalCounts = canonical.competitions.map((item) => item.entry_count);
    const evaluationCounts = evaluation.cases
      .filter((item) => item.id.startsWith("canonical-"))
      .map((item) => {
        const result = validateCompetitionBrief(item.expected_brief);
        if (!result.ok) throw new Error(JSON.stringify(result.issues));
        return result.brief.entry_count;
      });
    expect(evaluation.schema_version).toBe("1.0");
    expect(evaluation.canonical_source).toBe("validation/canonical-competitions.json");
    expect(evaluationCounts).toEqual(canonicalCounts);
    expect(evaluationCounts).toEqual([8, 12, 16, 24, 48]);
  });

  it.each(evaluation.cases)("validates and deterministically maps $id", (testCase) => {
    const result = validateCompetitionBrief(testCase.expected_brief);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    const setup = mapBriefToSetupInput(result.brief);
    if (testCase.available_match_slots === null) {
      expect(setup.ok).toBe(false);
      return;
    }
    expect(setup.ok).toBe(true);
    const recommendation = mapBriefToFormatRecommendationInput(result.brief, {
      availableMatchSlots: testCase.available_match_slots,
    });
    expect(recommendation).toMatchObject({
      ok: true,
      value: {
        entryCount: result.brief.entry_count,
        availableMatchSlots: testCase.available_match_slots,
      },
    });
  });

  it.each(evaluation.adversarial_outputs)("rejects adversarial output $id", (testCase) => {
    expect(validateCompetitionBrief(testCase.value).ok).toBe(false);
  });
});
