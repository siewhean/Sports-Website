import { describe, expect, it } from "vitest";
import {
  canonicalGateCC2ScreenshotPaths,
  canonicalGateCC2ResultSnapshot,
  gateCC2Projects,
  gateCC2BrowserSteps,
  gateCC2ScreenshotStems,
  gateCC2Sports,
  parseGateCC2Discovery,
  validateGateCC2BrowserReceipt,
  validateGateCC2ScreenshotPaths,
  validateGateCC2SemanticReceipt,
} from "../../scripts/gate-c-c2-evidence.js";

describe("Gate C C2 evidence discovery", () => {
  it("requires the complete three-project C2 matrix", () => {
    const output = [
      "Listing tests:",
      ...gateCC2Projects.map((project) => `  [${project}] › gate-c-c2-real.spec.ts:1:1 › C2 scoring`),
      "Total: 3 tests in 1 file",
    ].join("\n");
    expect(Object.fromEntries(parseGateCC2Discovery(output))).toEqual(
      Object.fromEntries(gateCC2Projects.map((project) => [project, 1])),
    );
  });

  it("fails when the C2 browser spec is absent from one project", () => {
    const output = [
      "Listing tests:",
      `  [${gateCC2Projects[0]}] › gate-c-c2-real.spec.ts:1:1 › C2 scoring`,
      `  [${gateCC2Projects[2]}] › gate-c-c2-real.spec.ts:1:1 › C2 scoring`,
      "Total: 2 tests in 1 file",
    ].join("\n");
    expect(() => parseGateCC2Discovery(output)).toThrow(`no tests for ${gateCC2Projects[1]}`);
  });

  it("reads the canonical persisted result snapshot segment shape", () => {
    const snapshot = {
      sportId: "badminton",
      lifecycle: "finalised",
      winner: "away",
      score: { home: 0, away: 1 },
      segments: [{ number: 1, home: 0, away: 1, completed: true, winner: "away", completionEventId: "event-1" }],
    };
    expect(canonicalGateCC2ResultSnapshot(JSON.stringify(snapshot))).toEqual({
      winner: "away",
      lifecycle: "finalised",
      segmentState: JSON.stringify([{ number: 1, home: 0, away: 1, completed: true, winner: "away" }]),
    });
    expect(() => canonicalGateCC2ResultSnapshot({ score: { home: 0, away: 1 } })).toThrow(/segments array/);
  });

  it("requires each exact C2 scorer and organiser screenshot exactly once", () => {
    const paths = gateCC2ScreenshotStems.map((stem) => `playwright/attachments/${stem}-${"a".repeat(40)}.png`);
    expect(validateGateCC2ScreenshotPaths(paths)).toEqual(paths);
    expect(() => validateGateCC2ScreenshotPaths(paths.slice(1))).toThrow(/found 0/);
    expect(() => validateGateCC2ScreenshotPaths([...paths, paths[0]!])).toThrow(/found 2/);
    expect(() => validateGateCC2ScreenshotPaths(["playwright/unrelated.png"])).toThrow(/found 0/);
  });

  it("records canonical screenshots without Playwright attachment copies", () => {
    const canonical = gateCC2ScreenshotStems.map((stem) => `playwright/result/${stem}.png`);
    const attachments = gateCC2ScreenshotStems.map(
      (stem) => `playwright/result/attachments/${stem}-${"a".repeat(40)}.png`,
    );
    expect(canonicalGateCC2ScreenshotPaths([...canonical, ...attachments])).toEqual(canonical);
    expect(() => canonicalGateCC2ScreenshotPaths([...canonical, canonical[0]!])).toThrow(/found 2/);
  });

  it("requires exact five-sport browser and direct database semantics", () => {
    const actions = ["goal", "point", "point", "point", "three_point_score"];
    const completions = [null, "game_completion", "game_completion", "set_completion", null];
    const browser = {
      artifact_kind: "gate-c-c2-browser-oracle" as const,
      project_name: gateCC2Projects[0],
      sports: gateCC2Sports.map((sport_id, index) => ({
        sport_id,
        action_event_type: actions[index]!,
        steps: [...gateCC2BrowserSteps],
        observed_result_versions: [1, 2, 3],
        observed_audit_event_count: 8,
        displayed_result: `Home 0–${sport_id === "basketball" ? 3 : 1} Away`,
      })),
      conflict_review: { sport_id: "canoe_polo", status: "acknowledged" as const },
    };
    const receipt = {
      artifact_kind: "gate-c-c2-semantic-oracle" as const,
      project_name: gateCC2Projects[0],
      browser,
      database: {
        sports: gateCC2Sports.map((sport_id, index) => ({
          sport_id,
          event_types: [
            "match_started",
            actions[index]!,
            ...(completions[index] ? [completions[index]!] : []),
            "finalisation",
            "match_reopened",
            "reversal",
          ],
          sequences: Array.from({ length: 10 }, (_, eventIndex) => eventIndex + 1),
          aggregate_versions: Array.from({ length: 10 }, (_, eventIndex) => eventIndex + 1),
          row_count: 10,
          distinct_client_event_count: 10,
          result_versions: [1, 2, 3],
          result_states: ["final", "corrected", "final"],
          result_scores: [
            `${sport_id === "basketball" ? 3 : 1}:0`,
            `0:${sport_id === "basketball" ? 3 : 1}`,
            `0:${sport_id === "basketball" ? 3 : 1}`,
          ],
          result_winners: ["home", "away", "away"],
          result_lifecycles: ["finalised", "finalised", "finalised"],
          result_segment_states: (["home", "away", "away"] as const).map((winner) =>
            JSON.stringify([
              {
                number: 1,
                home: winner === "home" ? (sport_id === "basketball" ? 3 : 1) : 0,
                away: winner === "away" ? (sport_id === "basketball" ? 3 : 1) : 0,
                completed: ["badminton", "table_tennis", "volleyball"].includes(sport_id),
                winner: ["badminton", "table_tennis", "volleyball"].includes(sport_id) ? winner : null,
              },
            ]),
          ),
          publication_result_version: 3,
          correction_transactions: 1,
          correction_from_version: 4,
          correction_through_version: 8,
          correction_result_version: 2,
          result_through_sequences: [3, 8, 10],
          stream_sport_code: sport_id,
          stream_pack_version: "0.1.0-draft.1",
          settings_fingerprint: "a".repeat(64),
          stream_current_version: 10,
          reversal_target_count: 1,
          reasoned_reversal_count: 1,
          valid_actor_count: 10,
          audit_actions: ["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"],
          outbox_event_types: ["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"],
        })),
        downstream_conflicts: {
          created: 1,
          acknowledged: 1,
          corrected_match_id: "source-match",
          downstream_match_id: "downstream-match",
          result_version: 2,
          reason: "downstream_match_started",
          acknowledgement_actor_present: true,
          acknowledgement_reason: "Reviewed against the corrected official result",
          audit_actions: ["result_conflict.created", "result_conflict.acknowledged"],
          outbox_event_types: ["result_conflict.created", "result_conflict.acknowledged"],
        },
      },
    };
    expect(validateGateCC2BrowserReceipt(browser, gateCC2Projects[0])).toEqual(browser);
    expect(validateGateCC2SemanticReceipt(receipt, gateCC2Projects[0])).toEqual(receipt);

    receipt.database.sports[0]!.distinct_client_event_count = 9;
    expect(() => validateGateCC2SemanticReceipt(receipt, gateCC2Projects[0])).toThrow(/direct database/);

    receipt.database.sports[0]!.distinct_client_event_count = 10;
    receipt.database.downstream_conflicts.acknowledged = 0;
    expect(() => validateGateCC2SemanticReceipt(receipt, gateCC2Projects[0])).toThrow(/downstream conflict/);
  });
});
