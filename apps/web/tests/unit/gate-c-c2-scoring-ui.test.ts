import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Gate C C2 scoring UI source guards", () => {
  it("renders one authoritative five-sport control surface without the Canoe-only write controls", async () => {
    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");

    expect(source).toContain("buildFiveSportScorecardDefinition(session.sportId, session.sportSettings)");
    expect(source).toContain("<FiveSportScoreControls");
    expect(source).toContain("[...scoreState.actions].reverse().map");
    expect(source).toContain("eventType: pendingAction.control.id");
    expect(source).toContain("eventType: phase2Machine.reversal");
    expect(source).not.toContain('className="p2-goal-controls"');
    expect(source).not.toContain('className="p2-other-controls"');
    expect(source).not.toContain("shot clock");
  });

  it("keeps one live announcement channel and deliberate dialog/review focus", async () => {
    const shell = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const controls = await readFile(
      new URL("../../components/phase5/FiveSportScoreControls.tsx", import.meta.url),
      "utf8",
    );

    // The access/confirm and live/review branches are mutually exclusive and
    // each renders exactly one announcement channel.
    expect(shell.match(/aria-live="polite"/g)).toHaveLength(2);
    expect(controls).not.toContain("aria-live");
    expect(shell).toContain("actionReturnTargetRef.current");
    expect(shell).toContain("returnTarget?.focus({ preventScroll: true })");
    expect(shell).toContain("finalReviewRef.current?.focus({ preventScroll: true })");
    expect(shell).toContain("interactionErrorRef.current?.focus({ preventScroll: true })");
    expect(shell).toContain("{interactionError ? (");
    expect(shell).toContain("scrollIntoView({ block: phase2Machine.scrollNearest })");
  });

  it("preserves dynamic attribution, segment and manual-time behavior with 48px controls", async () => {
    const shell = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const styles = await readFile(
      new URL("../../components/phase5/FiveSportScoreControls.module.css", import.meta.url),
      "utf8",
    );

    expect(shell).toContain('field.id === "manual_event_time" && field.enabled');
    expect(shell).toContain("pendingAction?.control.participantAttribution");
    expect(shell).toContain("definition.segments.map");
    expect(shell).toContain("allowUnknownScorer");
    expect(styles).toContain("min-height: 48px");
    expect(styles).toContain("@media (max-width: 30rem)");
  });

  it("keeps the default Canoe Polo surface focused while making advanced controls explicit", async () => {
    const shell = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const controls = await readFile(
      new URL("../../components/phase5/FiveSportScoreControls.tsx", import.meta.url),
      "utf8",
    );
    const scoreRoute = await readFile(new URL("../../app/score/page.tsx", import.meta.url), "utf8");

    expect(scoreRoute).toContain("advanced?: string");
    expect(scoreRoute).toContain('advancedMode={requestedSearchParams.advanced === "1"}');
    expect(shell).toContain(
      "const useSimpleCanoeControls = definition.sportId === phase2Machine.canoePolo && !advancedMode",
    );
    expect(shell).toContain(
      "useSimpleCanoeControls ? phase2Machine.scoreControlsRemote : phase2Machine.scoreControlsFull",
    );
    expect(shell).toContain('{advancedMode ? (\n        <section className="p5-scoring-device"');
    expect(shell).toContain("advancedMode && writerState === phase2Machine.candidate");
    expect(shell).toContain("advancedMode && action.reversible");
    expect(shell).toContain("const beginSheetDismiss");
    expect(shell).toContain("onPointerDown={beginSheetDismiss}");
    expect(shell).toContain("onPointerMove={continueSheetDismiss}");
    expect(controls).toContain('presentation?: "full" | "remote"');
    expect(controls).toContain("className={styles.remoteScoreAction}");
    expect(controls).toContain("<details className={styles.moreActions}>");
  });
});
