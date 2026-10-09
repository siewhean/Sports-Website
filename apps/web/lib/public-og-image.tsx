import { ImageResponse } from "next/og";
import { interpolate, messages } from "@matchday/ui";
import type { CompetitionView, MatchView } from "@/lib/phase2";
import { publicCompetitionPhase } from "@/lib/phase2-public-phase";

/*
 * Social preview cards (1200×630) for public competition and match pages, rendered with next/og.
 * Colours are the brand tokens from globals.css (--ink graphite, --signal chartreuse, dark --canvas / --surface).
 */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const INK = "#171918";
const CANVAS = "#111513";
const SURFACE = "#1b211e";
const SIGNAL = "#b7dc22";
const TEXT = "#f0f3ed";
const MUTED = "#bbc5ba";
const LINE = "#4b594e";

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function Frame({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: `linear-gradient(135deg, ${INK} 0%, ${CANVAS} 100%)`,
        color: TEXT,
        padding: "56px 64px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: SIGNAL,
              color: INK,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              fontWeight: 800,
            }}
          >
            {messages.brand.name.slice(0, 1)}
          </div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>{messages.brand.name}</div>
        </div>
        <div style={{ display: "flex", fontSize: 24, color: MUTED }}>{truncate(eyebrow, 60)}</div>
      </div>
      {children}
      <div style={{ display: "flex", fontSize: 22, color: MUTED, borderTop: `2px solid ${LINE}`, paddingTop: 20 }}>
        {messages.seo.imageFooter}
      </div>
    </div>
  );
}

function Badge({ label, live }: { label: string; live: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignSelf: "flex-start",
        padding: "6px 18px",
        borderRadius: 999,
        fontSize: 24,
        fontWeight: 700,
        background: live ? SIGNAL : SURFACE,
        color: live ? INK : TEXT,
        border: `2px solid ${live ? SIGNAL : LINE}`,
      }}
    >
      {label}
    </div>
  );
}

function liveMatch(competition: CompetitionView): MatchView | undefined {
  const matches = competition.publicDivisions?.flatMap((division) => division.matches) ?? competition.matches;
  return matches.find((match) => match.status === "live");
}

function competitionPhase(competition: CompetitionView, now: Date) {
  return publicCompetitionPhase(
    {
      status: competition.status ?? "published",
      startsOn: competition.startsOn,
      endsOn: competition.endsOn,
      timezone: competition.timezone,
      hasLiveMatch: Boolean(liveMatch(competition)),
    },
    now,
  );
}

export function competitionOgImage(competition: CompetitionView | null, now: Date = new Date()): ImageResponse {
  if (!competition) {
    return new ImageResponse(
      <Frame eyebrow={messages.metadata.defaultTitle}>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 800 }}>
          {messages.metadata.homeOpenGraphDescription}
        </div>
      </Frame>,
      OG_IMAGE_SIZE,
    );
  }
  const phase = competitionPhase(competition, now);
  const live = phase === "live" ? liveMatch(competition) : undefined;
  const leader = competition.standings[0];
  return new ImageResponse(
    <Frame eyebrow={`${competition.sport} · ${competition.dateLabel}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <Badge label={messages.publicCompetition.phase[phase]} live={phase === "live"} />
        <div style={{ display: "flex", fontSize: 76, fontWeight: 800, lineHeight: 1.05 }}>
          {truncate(competition.name, 48)}
        </div>
        {live && live.homeScore !== undefined && live.awayScore !== undefined ? (
          <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 40 }}>
            <div style={{ display: "flex", color: SIGNAL, fontWeight: 700 }}>{messages.seo.imageLiveNow}</div>
            <div style={{ display: "flex" }}>
              {`${truncate(live.home, 22)} ${live.homeScore}–${live.awayScore} ${truncate(live.away, 22)}`}
            </div>
          </div>
        ) : leader ? (
          <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 40 }}>
            <div style={{ display: "flex", color: SIGNAL, fontWeight: 700 }}>{messages.seo.imageLeader}</div>
            <div style={{ display: "flex" }}>{truncate(leader.team, 32)}</div>
            <div style={{ display: "flex", color: MUTED }}>
              {interpolate(messages.seo.imagePoints, { points: leader.points })}
            </div>
          </div>
        ) : null}
      </div>
    </Frame>,
    OG_IMAGE_SIZE,
  );
}

function matchStatusLabel(match: MatchView): string {
  if (match.status === "live") return messages.seo.imageLive;
  if (match.status === "final") return messages.seo.imageFinal;
  return messages.seo.imageScheduled;
}

function Side({ name, score }: { name: string; score: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "18px 28px",
        background: SURFACE,
        borderRadius: 16,
        border: `2px solid ${LINE}`,
      }}
    >
      <div style={{ display: "flex", fontSize: 52, fontWeight: 700 }}>{truncate(name, 28)}</div>
      <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: SIGNAL }}>{score}</div>
    </div>
  );
}

export function matchOgImage(competition: CompetitionView | null, match: MatchView | null): ImageResponse {
  if (!competition || !match) return competitionOgImage(competition);
  const scheduled = match.status === "scheduled";
  const score = (value: number | undefined) => (scheduled || value === undefined ? "–" : String(value));
  const when = match.date ? `${match.date} · ${match.time}` : match.time;
  return new ImageResponse(
    <Frame eyebrow={`${truncate(competition.name, 34)} · ${match.stage}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Badge label={matchStatusLabel(match)} live={match.status === "live"} />
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>{`${when} · ${match.area}`}</div>
        </div>
        <Side name={match.home} score={score(match.homeScore)} />
        <Side name={match.away} score={score(match.awayScore)} />
      </div>
    </Frame>,
    OG_IMAGE_SIZE,
  );
}
