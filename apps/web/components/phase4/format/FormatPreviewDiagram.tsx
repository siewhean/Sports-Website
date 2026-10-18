import type { ReactElement } from "react";
import { opaqueId } from "@matchday/ui";

type FormatPreviewDiagramProps = {
  readonly strategy: string;
  readonly entryCount?: number;
  readonly ariaLabel?: string;
};

const copy = {
  roundRobinAria: opaqueId("One league table, everyone plays everyone"),
  championshipAria8: opaqueId("Two groups of four, then semi-finals and final"),
  championshipAria12: opaqueId("Three groups of four, then knockouts and final"),
  championshipAria16: opaqueId("Four groups of four, then quarter-finals, semi-finals and final"),
  compactKnockoutAria: opaqueId("Single elimination knockout bracket"),
  doubleEliminationAria: opaqueId("Double elimination upper and lower brackets"),
  fullPlacementAria8: opaqueId("Two groups of four, then semi-finals, final and full placings"),
  fullPlacementAria12: opaqueId("Three groups of four, then knockouts, final and full placings"),
  fullPlacementAria16: opaqueId("Four groups of four, then quarter-finals, final and full placings"),
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
  moreGroups: (count: number) => opaqueId(`+${count} more`),
  championshipAriaMany: (groups: number) => opaqueId(`${groups} groups of four, then knockouts and final`),
  fullPlacementAriaMany: (groups: number) =>
    opaqueId(`${groups} groups of four, then knockouts, final and full placings`),
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
        <rect x={48} y={10} width={164} height={5} rx={2} fill="var(--signal)" />
        <g fill="var(--ink-muted)" opacity={0.4}>
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
    if (entryCount <= 8) {
      return (
        <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.championshipAria8}>
          <g fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x={8} y={16} width={64} height={32} rx={3} />
            <rect x={8} y={62} width={64} height={32} rx={3} />
            <path d="M72 32h36v12h18M72 78h36V66h18" />
            <rect x={126} y={35} width={44} height={18} rx={3} />
            <rect x={126} y={57} width={44} height={18} rx={3} />
            <path d="M170 44h22v11h18M170 66h22V55" />
            <rect x={210} y={46} width={44} height={18} rx={3} fill="var(--signal)" />
          </g>
          <g fontSize={10} fontWeight={800} fill="currentColor">
            <text x={16} y={36}>{`${copy.a} · 4`}</text>
            <text x={16} y={82}>{`${copy.b} · 4`}</text>
            <text x={132} y={48} fontSize={9}>
              {copy.sf1}
            </text>
            <text x={132} y={70} fontSize={9}>
              {copy.sf2}
            </text>
            <text x={216} y={58} fontSize={9} fill="var(--signal-ink)">
              {copy.final}
            </text>
          </g>
        </svg>
      );
    }

    if (entryCount === 12) {
      return (
        <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.championshipAria12}>
          <g fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x={6} y={10} width={58} height={26} rx={3} />
            <rect x={6} y={42} width={58} height={26} rx={3} />
            <rect x={6} y={74} width={58} height={26} rx={3} />
            <path d="M64 23h30v21h18M64 55h48M64 87h30V65h18" />
            <rect x={112} y={35} width={44} height={18} rx={3} />
            <rect x={112} y={57} width={44} height={18} rx={3} />
            <path d="M156 44h28v11h22M156 66h28V55" />
            <rect x={206} y={46} width={46} height={18} rx={3} fill="var(--signal)" />
          </g>
          <g fontSize={10} fontWeight={800} fill="currentColor">
            <text x={12} y={27}>{`${copy.a} · 4`}</text>
            <text x={12} y={59}>{`${copy.b} · 4`}</text>
            <text x={12} y={91}>{`${copy.c} · 4`}</text>
            <text x={118} y={48} fontSize={9}>
              {copy.sf1}
            </text>
            <text x={118} y={70} fontSize={9}>
              {copy.sf2}
            </text>
            <text x={212} y={58} fontSize={9} fill="var(--signal-ink)">
              {copy.final}
            </text>
          </g>
        </svg>
      );
    }

    // 16+ teams: the domain always builds groups of 4; beyond four groups the last row counts the rest.
    const groupCount = Math.ceil(entryCount / 4);
    const fourthGroup = groupCount > 4 ? copy.moreGroups(groupCount - 3) : `${copy.d} · 4`;
    return (
      <svg
        viewBox="0 0 260 110"
        role="img"
        aria-label={ariaLabel ?? (groupCount === 4 ? copy.championshipAria16 : copy.championshipAriaMany(groupCount))}
      >
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
          <text x={10} y={19}>{`${copy.a} · 4`}</text>
          <text x={10} y={45}>{`${copy.b} · 4`}</text>
          <text x={10} y={71}>{`${copy.c} · 4`}</text>
          <text x={10} y={97}>
            {fourthGroup}
          </text>
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
  if (entryCount <= 8) {
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.fullPlacementAria8}>
        <g fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x={6} y={10} width={64} height={32} rx={3} />
          <rect x={6} y={50} width={64} height={32} rx={3} />
          <path d="M70 26h30v14h18M70 66h30V52h18" />
          <rect x={118} y={33} width={42} height={16} rx={3} />
          <rect x={118} y={53} width={42} height={16} rx={3} />
          <path d="M160 41h24v11h18M160 61h24V52" />
          <rect x={202} y={43} width={46} height={18} rx={3} fill="var(--signal)" />
        </g>
        <g fontSize={10} fontWeight={800} fill="currentColor">
          <text x={12} y={30}>{`${copy.a} · 4`}</text>
          <text x={12} y={70}>{`${copy.b} · 4`}</text>
          <text x={124} y={45} fontSize={9}>
            {copy.sf1}
          </text>
          <text x={124} y={65} fontSize={9}>
            {copy.sf2}
          </text>
          <text x={208} y={56} fontSize={9} fill="var(--signal-ink)">
            {copy.final}
          </text>
        </g>
        <g fill="var(--ink-muted)" opacity={0.4}>
          <rect x={118} y={86} width={130} height={6} rx={2} />
          <rect x={118} y={96} width={130} height={6} rx={2} />
        </g>
      </svg>
    );
  }

  if (entryCount === 12) {
    return (
      <svg viewBox="0 0 260 110" role="img" aria-label={ariaLabel ?? copy.fullPlacementAria12}>
        <g fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x={6} y={8} width={58} height={22} rx={3} />
          <rect x={6} y={34} width={58} height={22} rx={3} />
          <rect x={6} y={60} width={58} height={22} rx={3} />
          <path d="M64 19h28v17h18M64 45h46M64 71h28V53h18" />
          <rect x={110} y={28} width={42} height={16} rx={3} />
          <rect x={110} y={48} width={42} height={16} rx={3} />
          <path d="M152 36h26v11h24M152 56h26V47" />
          <rect x={202} y={38} width={46} height={18} rx={3} fill="var(--signal)" />
        </g>
        <g fontSize={10} fontWeight={800} fill="currentColor">
          <text x={12} y={23}>{`${copy.a} · 4`}</text>
          <text x={12} y={49}>{`${copy.b} · 4`}</text>
          <text x={12} y={75}>{`${copy.c} · 4`}</text>
          <text x={116} y={40} fontSize={9}>
            {copy.sf1}
          </text>
          <text x={116} y={60} fontSize={9}>
            {copy.sf2}
          </text>
          <text x={208} y={51} fontSize={9} fill="var(--signal-ink)">
            {copy.final}
          </text>
        </g>
        <g fill="var(--ink-muted)" opacity={0.4}>
          <rect x={110} y={86} width={138} height={6} rx={2} />
          <rect x={110} y={96} width={138} height={6} rx={2} />
        </g>
      </svg>
    );
  }

  // 16+ teams: the domain always builds groups of 4; beyond four groups the last row counts the rest.
  const groupCount = Math.ceil(entryCount / 4);
  const fourthGroup = groupCount > 4 ? copy.moreGroups(groupCount - 3) : `${copy.d} · 4`;
  return (
    <svg
      viewBox="0 0 260 110"
      role="img"
      aria-label={ariaLabel ?? (groupCount === 4 ? copy.fullPlacementAria16 : copy.fullPlacementAriaMany(groupCount))}
    >
      <g fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x={4} y={4} width={56} height={18} rx={3} />
        <rect x={4} y={24} width={56} height={18} rx={3} />
        <rect x={4} y={44} width={56} height={18} rx={3} />
        <rect x={4} y={64} width={56} height={18} rx={3} />
        <path d="M60 13h18v11h14M60 33h18V24h14M60 53h18v11h14M60 73h18V64h14" />
        <rect x={92} y={17} width={42} height={14} rx={3} />
        <rect x={92} y={57} width={42} height={14} rx={3} />
        <path d="M134 24h20v14h18M134 64h20V50h18" />
        <rect x={172} y={38} width={38} height={14} rx={3} />
        <path d="M210 45h14" />
        <rect x={224} y={36} width={32} height={18} rx={3} fill="var(--signal)" />
      </g>
      <g fontSize={9} fontWeight={800} fill="currentColor">
        <text x={10} y={17}>{`${copy.a} · 4`}</text>
        <text x={10} y={37}>{`${copy.b} · 4`}</text>
        <text x={10} y={57}>{`${copy.c} · 4`}</text>
        <text x={10} y={77}>
          {fourthGroup}
        </text>
        <text x={98} y={28} fontSize={8}>
          {copy.sf1}
        </text>
        <text x={98} y={68} fontSize={8}>
          {copy.sf2}
        </text>
        <text x={228} y={48} fontSize={8} fill="var(--signal-ink)">
          {copy.final}
        </text>
      </g>
      <g fill="var(--ink-muted)" opacity={0.4}>
        <rect x={92} y={88} width={164} height={5} rx={2} />
        <rect x={92} y={97} width={164} height={5} rx={2} />
      </g>
    </svg>
  );
}
