import { interpolate, spectatorMessages as copy } from "@matchday/ui";
import type { MatchView } from "@/lib/phase2";
import { publicUi } from "@/lib/public-ui-tokens";
import styles from "./Walkover.module.css";

/** True when `side` won this match by walkover/forfeit. */
export function wonByWalkover(match: Pick<MatchView, "walkover">, side: "home" | "away"): boolean {
  return match.walkover?.winner === side;
}

/**
 * Visible "W/O" marker placed next to the entrant who won by walkover. The text itself carries the meaning
 * (never colour alone) and the accessible name spells it out for screen readers.
 */
export function WalkoverBadge({ team }: { team: string }) {
  return (
    <span className={styles.walkover} data-walkover="">
      <abbr title={copy.walkoverLabel} aria-hidden="true">
        {copy.walkoverBadge}
      </abbr>
      <span className="visually-hidden">{interpolate(copy.walkoverWinner, { team })}</span>
    </span>
  );
}

/** Badge for one side of a match: renders only when that side (`home` or `away`) won by walkover. */
export function WalkoverMark({
  match,
  home = false,
  away = false,
}: {
  match: Pick<MatchView, "walkover" | "home" | "away">;
  home?: boolean;
  away?: boolean;
}) {
  if (home && wonByWalkover(match, publicUi.home)) return <WalkoverBadge team={match.home} />;
  if (away && wonByWalkover(match, publicUi.away)) return <WalkoverBadge team={match.away} />;
  return null;
}

/** Detailed-score text for a walkover, e.g. "W/O (Forfeit score: 5–0)"; null when the match was played. */
export function walkoverDetail(match: Pick<MatchView, "walkover" | "homeScore" | "awayScore">): string | null {
  if (!match.walkover) return null;
  return interpolate(copy.walkoverDetail, { home: match.homeScore ?? 0, away: match.awayScore ?? 0 });
}
