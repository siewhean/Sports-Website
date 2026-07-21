import { Target } from "@phosphor-icons/react";
import { scorekeeperFixture } from "./__fixtures__/scorekeeperFixture";
import type { ScorekeeperTeam } from "./types";
import styles from "../ScorekeeperPrototype.module.css";
import { cssModuleClasses as cx } from "../prototype/cssModuleClasses";

type TeamScorePanelProps = {
  side: ScorekeeperTeam;
  score: number;
  disabled: boolean;
  onGoal: (team: ScorekeeperTeam) => void;
};

export function TeamScorePanel({ side, score, disabled, onGoal }: TeamScorePanelProps) {
  const fixture = scorekeeperFixture.teams[side];

  return (
    <div className={cx(styles, "scorekeeper-team", side === "gold" && "scorekeeper-team--gold")}>
      <span className={cx(styles, "scorekeeper-team-mark")} aria-hidden="true" />
      <p>{fixture.name}</p>
      <strong aria-label={fixture.scoreAriaLabel(score)}>{score}</strong>
      <button type="button" onClick={() => onGoal(side)} disabled={disabled}>
        <Target size={30} aria-hidden="true" />
        {fixture.goalButtonLabel}
      </button>
    </div>
  );
}
