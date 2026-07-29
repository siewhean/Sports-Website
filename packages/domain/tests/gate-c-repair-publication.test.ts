import { describe, expect, it } from "vitest";
import {
  buildRepairPublicationPlan,
  calculateAffectedMatchClosure,
  type AffectedMatchClosureInput,
  type RepairPublicationDecision,
} from "../src/index.js";

function closureInput(): AffectedMatchClosureInput {
  return {
    competitionId: "competition-1",
    correctedMatchId: "semi-1",
    sourceResultVersion: 8,
    sourceScheduleVersion: 5,
    matches: [
      {
        matchId: "semi-1",
        divisionId: "division-open",
        state: "final",
        homeEntryId: "team-a",
        awayEntryId: "team-b",
        homeControl: "automatic",
        awayControl: "automatic",
      },
      {
        matchId: "safe-final",
        divisionId: "division-open",
        state: "pending",
        homeEntryId: "team-a",
        awayEntryId: "team-c",
        homeControl: "automatic",
        awayControl: "automatic",
      },
      {
        matchId: "started-third",
        divisionId: "division-open",
        state: "in_progress",
        homeEntryId: "team-a",
        awayEntryId: "team-d",
        homeControl: "automatic",
        awayControl: "automatic",
      },
      {
        matchId: "manual-placement",
        divisionId: "division-elite",
        state: "ready",
        homeEntryId: "team-a",
        awayEntryId: "team-e",
        homeControl: "manual",
        awayControl: "automatic",
      },
      {
        matchId: "unresolved-next",
        divisionId: "division-elite",
        state: "pending",
        homeEntryId: "team-a",
        awayEntryId: "team-f",
        homeControl: "automatic",
        awayControl: "automatic",
      },
    ],
    dependencies: [
      { sourceMatchId: "semi-1", downstreamMatchId: "safe-final", slot: "home", outcome: "winner" },
      { sourceMatchId: "semi-1", downstreamMatchId: "started-third", slot: "home", outcome: "loser" },
      { sourceMatchId: "semi-1", downstreamMatchId: "manual-placement", slot: "home", outcome: "winner" },
      { sourceMatchId: "safe-final", downstreamMatchId: "unresolved-next", slot: "home", outcome: "winner" },
    ],
    proposedOutcomes: [{ matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" }],
  };
}

function plan(decisions: readonly RepairPublicationDecision[] = []) {
  return buildRepairPublicationPlan(calculateAffectedMatchClosure(closureInput()), decisions);
}

describe("Gate C C4 repair publication planning", () => {
  it("automatically resolves safe and unchanged actions but blocks protected and unresolved actions", () => {
    const result = plan();

    expect(result.ready).toBe(false);
    expect(result.resolutions).toEqual([
      {
        matchId: "safe-final",
        divisionId: "division-open",
        slot: "home",
        sourceAction: "automatic_update",
        decision: "accept_proposed",
        resolvedEntryId: "team-b",
        reason: "Safe automatic repair accepted by policy",
      },
    ]);
    expect(result.unresolved.map(({ matchId, action }) => [matchId, action])).toEqual([
      ["manual-placement", "protected_manual_slot"],
      ["started-third", "protected_started_match"],
      ["unresolved-next", "requires_organiser_decision"],
    ]);
  });

  it("becomes publishable only after protected and unresolved actions receive explicit decisions", () => {
    const result = plan([
      {
        matchId: "started-third",
        slot: "home",
        decision: "leave_protected",
        reason: "Match already started",
      },
      {
        matchId: "manual-placement",
        slot: "home",
        decision: "set_manual_entry",
        selectedEntryId: "team-g",
        reason: "Organiser selected the replacement",
      },
      {
        matchId: "unresolved-next",
        slot: "home",
        decision: "keep_current",
        reason: "Awaiting the preceding repaired result",
      },
    ]);

    expect(result.ready).toBe(true);
    expect(result.unresolved).toEqual([]);
    expect(
      Object.fromEntries(result.resolutions.map((resolution) => [resolution.matchId, resolution.resolvedEntryId])),
    ).toEqual({
      "manual-placement": "team-g",
      "safe-final": "team-b",
      "started-third": "team-a",
      "unresolved-next": "team-a",
    });
  });

  it("allows an organiser to preserve or manually override a safe automatic update with a reason", () => {
    const kept = plan([
      {
        matchId: "safe-final",
        slot: "home",
        decision: "keep_current",
        reason: "Published team briefing already completed",
      },
      {
        matchId: "started-third",
        slot: "home",
        decision: "leave_protected",
        reason: "Match already started",
      },
      {
        matchId: "manual-placement",
        slot: "home",
        decision: "keep_current",
        reason: "Manual slot stays unchanged",
      },
      {
        matchId: "unresolved-next",
        slot: "home",
        decision: "leave_protected",
        reason: "Participant remains unresolved",
      },
    ]);
    expect(kept.resolutions.find(({ matchId }) => matchId === "safe-final")?.resolvedEntryId).toBe("team-a");

    const manual = plan([
      {
        matchId: "safe-final",
        slot: "home",
        decision: "set_manual_entry",
        selectedEntryId: "team-z",
        reason: "Organiser applied a manual replacement",
      },
      {
        matchId: "started-third",
        slot: "home",
        decision: "keep_current",
        reason: "Started match is protected",
      },
      {
        matchId: "manual-placement",
        slot: "home",
        decision: "keep_current",
        reason: "Manual slot stays unchanged",
      },
      {
        matchId: "unresolved-next",
        slot: "home",
        decision: "keep_current",
        reason: "Participant remains unresolved",
      },
    ]);
    expect(manual.resolutions.find(({ matchId }) => matchId === "safe-final")?.resolvedEntryId).toBe("team-z");
  });

  it("rejects decisions for unknown or unchanged actions, duplicates, missing reasons and unsafe protected rewrites", () => {
    expect(() =>
      plan([{ matchId: "missing", slot: "home", decision: "keep_current", reason: "Unknown match" }]),
    ).toThrow(/unknown action/);

    expect(() =>
      plan([
        { matchId: "started-third", slot: "home", decision: "keep_current", reason: "First reason" },
        { matchId: "started-third", slot: "home", decision: "leave_protected", reason: "Second reason" },
      ]),
    ).toThrow(/Duplicate repair decision/);

    expect(() => plan([{ matchId: "started-third", slot: "home", decision: "keep_current" }])).toThrow(
      /requires a reason/,
    );

    expect(() =>
      plan([
        {
          matchId: "started-third",
          slot: "home",
          decision: "set_manual_entry",
          selectedEntryId: "team-z",
          reason: "Unsafe rewrite",
        },
      ]),
    ).toThrow(/not permitted/);
  });

  it("rejects accepting an unresolved participant and manual decisions without a selected entry", () => {
    expect(() =>
      plan([
        {
          matchId: "unresolved-next",
          slot: "home",
          decision: "accept_proposed",
        },
      ]),
    ).toThrow(/cannot accept an unresolved participant/);

    expect(() =>
      plan([
        {
          matchId: "manual-placement",
          slot: "home",
          decision: "set_manual_entry",
          reason: "Manual choice required",
        },
      ]),
    ).toThrow(/requires an entry/);
  });

  it("produces deterministic resolution order and fingerprint input regardless of decision order", () => {
    const decisions: RepairPublicationDecision[] = [
      {
        matchId: "started-third",
        slot: "home",
        decision: "leave_protected",
        reason: "Match already started",
      },
      {
        matchId: "manual-placement",
        slot: "home",
        decision: "set_manual_entry",
        selectedEntryId: "team-g",
        reason: "Organiser selected the replacement",
      },
      {
        matchId: "unresolved-next",
        slot: "home",
        decision: "keep_current",
        reason: "Awaiting the preceding repaired result",
      },
    ];
    const forward = plan(decisions);
    const reversed = plan([...decisions].reverse());

    expect(reversed.resolutions).toEqual(forward.resolutions);
    expect(reversed.publicationFingerprintInput).toBe(forward.publicationFingerprintInput);
  });
});
