import type { FiveSportScorecardDefinition, ScorecardControl, ScorecardControlKind } from "./five-sport-scorecard";

export type ScoreControlSide = "home" | "away";

export type ScoreControlAction = Readonly<{
  key: string;
  group: ScorecardControlKind;
  control: ScorecardControl;
  side: ScoreControlSide | null;
}>;

export type ScoreControlActionGroup = Readonly<{
  kind: ScorecardControlKind;
  actions: readonly ScoreControlAction[];
}>;

function actionsForControl(control: ScorecardControl): readonly ScoreControlAction[] {
  if (control.requiresSide || control.kind === "score") {
    return Object.freeze(
      (["home", "away"] as const).map((side) =>
        Object.freeze({
          key: `${control.kind}:${control.id}:${side}`,
          group: control.kind,
          control,
          side,
        }),
      ),
    );
  }
  return Object.freeze([
    Object.freeze({
      key: `${control.kind}:${control.id}:global`,
      group: control.kind,
      control,
      side: null,
    }),
  ]);
}

export function buildFiveSportScoreControlGroups(
  definition: FiveSportScorecardDefinition,
): readonly ScoreControlActionGroup[] {
  const controls: Readonly<Record<ScorecardControlKind, readonly ScorecardControl[]>> = {
    score: definition.scoreControls,
    segment_completion: definition.segmentCompletionControls,
    operational: definition.operationalControls,
    exceptional_outcome: definition.exceptionalOutcomeControls,
  };

  return Object.freeze(
    (Object.keys(controls) as ScorecardControlKind[])
      .map((kind) =>
        Object.freeze({
          kind,
          actions: Object.freeze(controls[kind].flatMap(actionsForControl)),
        }),
      )
      .filter((group) => group.actions.length > 0),
  );
}
