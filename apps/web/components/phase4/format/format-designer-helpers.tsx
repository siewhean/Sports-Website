import { GitBranch, Medal, SquaresFour, Trophy, UsersThree } from "@phosphor-icons/react";
import type { Phase4FormatGraphStage } from "@matchday/contracts";

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 132;
export const MOVE_STEP = 12;

export function focusIssue(path: string) {
  const stageIndex = /stages\[(\d+)\]/.exec(path)?.[1];
  window.requestAnimationFrame(() => {
    (stageIndex
      ? document.querySelector<HTMLElement>(`[data-stage-index="${stageIndex}"]`)
      : document.querySelector<HTMLElement>("[data-issue='true']")
    )?.focus();
  });
}

export function stageIcon(kind: Phase4FormatGraphStage["kind"]) {
  if (kind === "group") return <UsersThree />;
  if (kind === "placement" || kind === "bronze") return <Medal />;
  if (kind === "single_elimination") return <Trophy />;
  if (kind === "round_robin") return <SquaresFour />;
  return <GitBranch />;
}

export function buildConnections(
  matches: readonly { id: string; stageId: string; home: unknown; away: unknown }[],
  positions: Map<string, { x: number; y: number }>,
) {
  const stageByMatch = new Map(matches.map((match) => [match.id, match.stageId]));
  const keys = new Set<string>();
  const result: Array<{ id: string; path: string }> = [];
  for (const match of matches)
    for (const source of [match.home, match.away]) {
      const item = source as { type?: string; stageId?: string; matchId?: string };
      const fromId =
        item.type === "stage_rank"
          ? item.stageId
          : item.type === "winner" || item.type === "loser"
            ? stageByMatch.get(item.matchId ?? "")
            : null;
      if (!fromId || fromId === match.stageId) continue;
      const key = `${fromId}:${match.stageId}`;
      if (keys.has(key)) continue;
      const from = positions.get(fromId);
      const to = positions.get(match.stageId);
      if (!from || !to) continue;
      keys.add(key);
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;
      const mx = x1 + Math.max(45, (x2 - x1) / 2);
      result.push({ id: key, path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` });
    }
  return result;
}
