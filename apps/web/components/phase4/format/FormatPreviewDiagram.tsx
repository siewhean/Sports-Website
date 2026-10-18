import type { ReactElement } from "react";
import { opaqueId } from "@matchday/ui";

type FormatPreviewDiagramProps = {
  readonly strategy: string;
  readonly entryCount?: number;
  readonly ariaLabel?: string;
};

const copy = {
  roundRobinAria: opaqueId("One league table, everyone plays everyone"),
  championshipAria: opaqueId("Four groups, then quarter-finals, semi-finals and final"),
  compactKnockoutAria: opaqueId("Single elimination knockout bracket"),
  doubleEliminationAria: opaqueId("Double elimination upper and lower brackets"),
  fullPlacementAria: opaqueId("Two groups, then semi-finals, final and full placings"),
  a: opaqueId("A"),
  b: opaqueId("B"),
  c: opaqueId("C"),
  d: opaqueId("D"),
  qf1: opaqueId("QF 1"),
  qf2: opaqueId("QF 2"),
  qf3: opaqueId("QF 3"),
  qf4: opaqueId("QF 4"),
  sf1: opaqueId("SF 1"),
  sf2: opaqueId("SF 2"),
  final: opaqueId("Final"),
  grandFinal: opaqueId("Grand Final"),
  ub1: opaqueId("UB 1"),
  ub2: opaqueId("UB 2"),
  ubFinal: opaqueId("UB Final"),
  lb1: opaqueId("LB 1"),
  lb2: opaqueId("LB 2"),
  lbFinal: opaqueId("LB Final"),
  teamsSuffix: (count: number) => opaqueId(`${count} teams`),
};

export function FormatPreviewDiagram({
  strategy,
  entryCount = 12,
  ariaLabel,
}: FormatPreviewDiagramProps): ReactElement {
  if (strategy === "round_robin") {
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.roundRobinAria}>
        <g stroke="currentColor" strokeWidth={2} fill="none">
          <rect x={40} y={4} width={180} height={102} rx={4} />
        </g>
        <g fill="var(--muted)">
          <rect x={48} y={10} width={164} height={5} rx={2} fill="var(--signal)" />
          <rect x={48} y={19} width={158} height={5} rx={2} />
          <rect x={48} y={28} width={152} height={5} rx={2} />
          <rect x={48} y={37} width={146} height={5} rx={2} />
          <rect x={48} y={46} width={140} height={5} rx={2} />
          <rect x={48} y={55} width={134} height={5} rx={2} />
          <rect x={48} y={64} width={128} height={5} rx={2} />
          <rect x={48} y={73} width={122} height={5} rx={2} />
          <rect x={48} y={82} width={116} height={5} rx={2} />
          <rect x={48} y={91} width={110} height={5} rx={2} />
          <rect x={48} y={100} width={104} height={5} rx={2} />
        </g>
      </svg>
    );
  }

  if (strategy === "championship_focus") {
    const teamsPerGroup = Math.max(3, Math.round(entryCount / 4));
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.championshipAria}>
        <g fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x={4} y={4} width={54} height={22} rx={3} />
          <rect x={4} y={30} width={54} height={22} rx={3} />
          <rect x={4} y={56} width={54} height={22} rx={3} />
          <rect x={4} y={82} width={54} height={22} rx={3} />
          <path d="M58 15h20M58 41h20M58 67h20M58 93h20" />
          <rect x={78} y={8} width={40} height={14} rx={3} />
          <rect x={78} y={34} width={40} height={14} rx={3} />
          <rect x={78} y={60} width={40} height={14} rx={3} />
          <rect x={78} y={86} width={40} height={14} rx={3} />
          <path d="M118 15h14v13h14M118 41h14V28M118 67h14v13h14M118 93h14V80" />
          <rect x={146} y={21} width={40} height={14} rx={3} />
          <rect x={146} y={73} width={40} height={14} rx={3} />
          <path d="M186 28h14v26h14M186 80h14V54" />
          <rect x={214} y={47} width={42} height={16} rx={3} fill="var(--signal)" />
        </g>
        <g fontSize={10} fontWeight={800} fill="currentColor">
          <text x={10} y={19}>{`${copy.a} · ${teamsPerGroup}`}</text>
          <text x={10} y={45}>{`${copy.b} · ${teamsPerGroup}`}</text>
          <text x={10} y={71}>{`${copy.c} · ${teamsPerGroup}`}</text>
          <text x={10} y={97}>{`${copy.d} · ${teamsPerGroup}`}</text>
          <text x={219} y={59} fontSize={9} fill="var(--signal-ink)">
            {copy.final}
          </text>
        </g>
      </svg>
    );
  }

  if (strategy === "compact_knockout") {
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.compactKnockoutAria}>
        <g fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x={4} y={8} width={48} height={18} rx={3} />
          <rect x={4} y={34} width={48} height={18} rx={3} />
          <rect x={4} y={60} width={48} height={18} rx={3} />
          <rect x={4} y={86} width={48} height={18} rx={3} />
          <path d="M52 17h20v13h18M52 43h20V30h18M52 69h20v13h18M52 95h20V82h18" />
          <rect x={90} y={21} width={48} height={18} rx={3} />
          <rect x={90} y={73} width={48} height={18} rx={3} />
          <path d="M138 30h24v25h18M138 82h24V55h18" />
          <rect x={180} y={46} width={56} height={18} rx={3} fill="var(--signal)" />
        </g>
        <g fontSize={9} fontWeight={800} fill="currentColor">
          <text x={10} y={21}>
            {copy.qf1}
          </text>
          <text x={10} y={47}>
            {copy.qf2}
          </text>
          <text x={10} y={73}>
            {copy.qf3}
          </text>
          <text x={10} y={99}>
            {copy.qf4}
          </text>
          <text x={96} y={34}>
            {copy.sf1}
          </text>
          <text x={96} y={86}>
            {copy.sf2}
          </text>
          <text x={190} y={59} fill="var(--signal-ink)">
            {copy.final}
          </text>
        </g>
      </svg>
    );
  }

  if (strategy === "double_elimination") {
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.doubleEliminationAria}>
        <g fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x={4} y={8} width={46} height={16} rx={3} />
          <rect x={4} y={30} width={46} height={16} rx={3} />
          <path d="M50 16h18v11h16M50 38h18V27h16" />
          <rect x={84} y={19} width={48} height={16} rx={3} />
          <path d="M132 27h36v25h18" />

          <rect x={4} y={62} width={46} height={16} rx={3} />
          <rect x={4} y={84} width={46} height={16} rx={3} />
          <path d="M50 70h18v11h16M50 92h18V81h16" />
          <rect x={84} y={73} width={48} height={16} rx={3} />
          <path d="M132 81h36V52h18" />

          <rect x={188} y={44} width={58} height={18} rx={3} fill="var(--signal)" />
        </g>
        <g fontSize={8} fontWeight={800} fill="currentColor">
          <text x={8} y={20}>
            {copy.ub1}
          </text>
          <text x={8} y={42}>
            {copy.ub2}
          </text>
          <text x={88} y={31}>
            {copy.ubFinal}
          </text>
          <text x={8} y={74}>
            {copy.lb1}
          </text>
          <text x={8} y={96}>
            {copy.lb2}
          </text>
          <text x={88} y={85}>
            {copy.lbFinal}
          </text>
          <text x={194} y={56} fill="var(--signal-ink)">
            {copy.grandFinal}
          </text>
        </g>
      </svg>
    );
  }

  // Default: full_placement (Groups -> Knockout -> Placement rows)
  const teamsPerGroup = Math.max(3, Math.round(entryCount / 2));
  return (
    <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.fullPlacementAria}>
      <g fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x={4} y={6} width={70} height={44} rx={4} />
        <rect x={4} y={60} width={70} height={44} rx={4} />
        <path d="M74 28h30v18h26M74 82h30V64h26" />
        <rect x={130} y={34} width={44} height={18} rx={3} />
        <rect x={130} y={58} width={44} height={18} rx={3} />
        <path d="M174 43h20v12h18M174 67h20V55" />
        <rect x={212} y={46} width={44} height={18} rx={3} fill="var(--signal)" />
      </g>
      <g fontSize={11} fontWeight={800} fill="currentColor">
        <text x={12} y={24}>
          {copy.a}
        </text>
        <text x={12} y={78}>
          {copy.b}
        </text>
        <text x={12} y={40} fontWeight={400} fontSize={9}>
          {copy.teamsSuffix(teamsPerGroup)}
        </text>
        <text x={12} y={94} fontWeight={400} fontSize={9}>
          {copy.teamsSuffix(teamsPerGroup)}
        </text>
        <text x={136} y={47} fontSize={9}>
          {copy.sf1}
        </text>
        <text x={136} y={71} fontSize={9}>
          {copy.sf2}
        </text>
        <text x={218} y={59} fontSize={9} fill="var(--signal-ink)">
          {copy.final}
        </text>
      </g>
      <g fill="var(--muted)">
        <rect x={130} y={86} width={126} height={6} rx={2} />
        <rect x={130} y={96} width={126} height={6} rx={2} />
      </g>
    </svg>
  );
}
