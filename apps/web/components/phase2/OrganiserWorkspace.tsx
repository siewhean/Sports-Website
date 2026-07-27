import Link from "next/link";
import type { ReactNode } from "react";
import { opaqueId, translate as t } from "@matchday/ui";
import {
  ArrowRight,
  CalendarDots,
  Check,
  Gauge,
  LockKey,
  ShieldCheck,
  UsersThree,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import {
  organiserSections,
  phase2Competition,
  phase2Copy,
  phase2Machine,
  type CompetitionView,
  type OrganiserSection,
  type SurfaceState,
} from "@/lib/phase2";
import { SurfaceStatePanel } from "./SurfaceState";
import { AccessPassManager } from "@/components/phase5/AccessPassManager";

function sectionMeta(competition: CompetitionView, section: OrganiserSection): { title: string; intro: string } {
  const shared: Record<OrganiserSection, { title: string; intro: string }> = {
    "control-room": { title: phase2Copy.controlTitle, intro: phase2Copy.controlIntro },
    setup: { title: phase2Copy.setupTitle, intro: phase2Copy.setupIntro },
    settings: {
      title: `${competition.sport} settings`,
      intro: `Review the pinned ${competition.sport} pack and customise the settings used by this competition.`,
    },
    entries: {
      title: t("prototype.10beee7f51f8"),
      intro: t("prototype.2a3b50533f9f"),
    },
    capacity: { title: phase2Copy.capacityTitle, intro: phase2Copy.capacityIntro },
    format: {
      title: t("prototype.675eeee2578b"),
      intro: t("prototype.db67c10aa708"),
    },
    schedule: {
      title: phase2Copy.scheduleTitle,
      intro: t("prototype.e94338d24608"),
    },
    results: { title: phase2Copy.resultsTitle, intro: phase2Copy.resultsIntro },
    publish: { title: phase2Copy.publishTitle, intro: phase2Copy.publishIntro },
    access: { title: phase2Copy.accessTitle, intro: phase2Copy.accessIntro },
    audit: { title: phase2Copy.auditTitle, intro: phase2Copy.auditIntro },
  };
  return shared[section];
}

function navigation(competition: CompetitionView) {
  return organiserSections.map((item) => {
    if (item.id === "settings")
      return { ...item, short: t("prototype.74a883a037bc"), label: `${competition.sport} settings` };
    if (item.id === "entries")
      return { ...item, short: t("prototype.7cb76b4af12a"), label: t("prototype.10beee7f51f8") };
    if (item.id === "format")
      return { ...item, short: t("prototype.2f343666aaa8"), label: t("prototype.675eeee2578b") };
    return item;
  });
}

export function OrganiserWorkspace({
  competition = phase2Competition,
  section = phase2Machine.controlRoom,
  state = phase2Machine.ready,
  sectionContent,
  sectionAction,
  pageTitle,
  pageIntro,
  pageEyebrow,
  syncLabel,
  syncState,
  layoutMode = opaqueId("default"),
}: {
  competition?: CompetitionView;
  section?: OrganiserSection;
  state?: SurfaceState;
  sectionContent?: ReactNode;
  sectionAction?: ReactNode;
  pageTitle?: string;
  pageIntro?: string;
  pageEyebrow?: string;
  syncLabel?: string;
  syncState?: "saved" | "local" | "unavailable" | "offline" | "conflict" | "read-only";
  layoutMode?: "default" | "setup" | "format";
}) {
  const fallbackMeta = sectionMeta(competition, section);
  const meta = {
    title: pageTitle ?? fallbackMeta.title,
    intro: pageIntro ?? fallbackMeta.intro,
  };
  const organiserBase = `/organiser/competitions/${competition.id}`;
  const content =
    state === "ready" ? (
      (sectionContent ?? <SectionContent competition={competition} section={section} />)
    ) : (
      <SurfaceStatePanel state={state} />
    );

  return (
    <div className={`p2-organiser p2-organiser--${layoutMode}`}>
      <a className="skip-link" href="#p2-workspace">
        {phase2Copy.skip}
      </a>
      {layoutMode !== "format" ? (
        <header className="p2-organiser__topbar">
          <Link className="p2-wordmark" href="/">
            <span aria-hidden="true">{phase2Copy.logoMark}</span>
            {phase2Copy.brand}
          </Link>
          <div className="p2-context">
            <span>{competition.name}</span>
            <small>{competition.publicationRevision}</small>
          </div>
          <p className="p2-sync" data-sync-state={syncState}>
            <span aria-hidden="true" />
            {syncLabel ?? phase2Copy.draftSynced}
          </p>
        </header>
      ) : null}
      <div className="p2-organiser__layout">
        <nav className="p2-organiser__nav" aria-label={phase2Copy.organiserNav}>
          {navigation(competition).map((item) => (
            <Link
              key={item.id}
              href={item.id === "control-room" ? organiserBase : `${organiserBase}/${item.id}`}
              aria-current={item.id === section ? "page" : undefined}
            >
              <span>{item.short}</span>
              <small>{item.label}</small>
            </Link>
          ))}
          <Link href="/">{phase2Copy.backHome}</Link>
        </nav>
        <main className="p2-organiser__main" id="p2-workspace" tabIndex={-1}>
          {layoutMode === "default" ? (
            <header className="p2-page-heading">
              <div>
                <p className="p2-eyebrow">{pageEyebrow ?? competition.division.name}</p>
                <h1>{meta.title}</h1>
                <p>{meta.intro}</p>
              </div>
              {sectionAction !== undefined ? (
                sectionAction
              ) : section === "control-room" ? (
                <Link className="p2-button p2-button--signal" href={`${organiserBase}/publish`}>
                  {phase2Copy.openPublic}
                  <span aria-hidden="true">
                    <ArrowRight />
                  </span>
                </Link>
              ) : (
                <button className="p2-button p2-button--dark" type="button">
                  {phase2Copy.save}
                </button>
              )}
            </header>
          ) : null}
          {content}
        </main>
      </div>
    </div>
  );
}

function SectionContent({ competition, section }: { competition: CompetitionView; section: OrganiserSection }) {
  switch (section) {
    case "control-room":
      return <ControlRoom competition={competition} />;
    case "setup":
      return <Setup competition={competition} />;
    case "settings":
      return <Settings competition={competition} />;
    case "entries":
      return <Entries competition={competition} />;
    case "capacity":
      return <Capacity competition={competition} />;
    case "format":
      return <Format competition={competition} />;
    case "schedule":
      return <Schedule competition={competition} />;
    case "results":
      return <SurfaceStatePanel state={phase2Machine.empty} />;
    case "publish":
      return <Publish competition={competition} />;
    case "access":
      return <Access competition={competition} />;
    case "audit":
      return <Audit competition={competition} />;
  }
}

function ControlRoom({ competition }: { competition: CompetitionView }) {
  const live = competition.matches.find((match) => match.status === "live");
  const upcoming = competition.matches.filter((match) => match.status === "scheduled").slice(0, 3);
  return (
    <div className="p2-control-grid">
      <section className="p2-live-result" aria-labelledby="live-result-title">
        <div className="p2-section-label">
          <span />
          {phase2Copy.liveNow}
        </div>
        {live ? (
          <>
            <div className="p2-live-result__meta">
              <h2 id="live-result-title">{live.label}</h2>
              <span>
                {live.stage} · {live.area}
              </span>
            </div>
            <div className="p2-live-result__score">
              <div>
                <span>{live.home}</span>
                <strong>{live.homeScore}</strong>
              </div>
              <small>{live.status}</small>
              <div>
                <span>{live.away}</span>
                <strong>{live.awayScore}</strong>
              </div>
            </div>
            <p>{competition.lastUpdated}</p>
          </>
        ) : (
          <div className="p2-live-result__meta">
            <h2 id="live-result-title">{phase2Copy.emptyTitle}</h2>
            <span>{phase2Copy.emptyBody}</span>
          </div>
        )}
      </section>
      {competition.attention ? (
        <aside className="p2-attention" aria-labelledby="attention-title">
          <Warning weight="fill" aria-hidden="true" />
          <p>{phase2Copy.attention}</p>
          <h2 id="attention-title">{competition.attention.body}</h2>
          <Link href={competition.attention.href}>
            {phase2Copy.resolve}
            <ArrowRight />
          </Link>
        </aside>
      ) : null}
      <section className="p2-next" aria-labelledby="next-title">
        <header>
          <CalendarDots />
          <h2 id="next-title">{phase2Copy.nextMatches}</h2>
        </header>
        <ol>
          {upcoming.map((match) => (
            <li key={match.id}>
              <time>{match.time}</time>
              <span>
                <strong>{match.home}</strong>
                <small>
                  {match.stage} · {match.area}
                </small>
              </span>
              <span>{match.away}</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="p2-readiness" aria-labelledby="readiness-title">
        <header>
          <ShieldCheck />
          <h2 id="readiness-title">{phase2Copy.readiness}</h2>
        </header>
        <strong>{competition.publicationState === "draft" ? phase2Copy.notPublished : phase2Copy.allReady}</strong>
        <dl>
          <div>
            <dt>{phase2Copy.publicVersion}</dt>
            <dd>{competition.publicationRevision}</dd>
          </div>
          <div>
            <dt>{phase2Copy.freshness}</dt>
            <dd>{competition.lastUpdated}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function Setup({ competition }: { competition: CompetitionView }) {
  return (
    <div className="p2-form-grid">
      <Field label={phase2Copy.competitionName} value={competition.name} wide />
      <Field label={phase2Copy.sport} value={competition.sport} />
      <Field label={phase2Copy.timezone} value={competition.timezone} />
      <Field label={phase2Copy.venue} value={competition.venue} />
      <Field label={phase2Copy.dates} value={competition.dateLabel} />
    </div>
  );
}

function Settings({ competition }: { competition: CompetitionView }) {
  if (!competition.settings?.length) return <SurfaceStatePanel state={phase2Machine.empty} />;
  return (
    <dl className="p2-definition-list">
      {competition.settings.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
          <button type="button">{phase2Copy.edit}</button>
        </div>
      ))}
    </dl>
  );
}

function Entries({ competition }: { competition: CompetitionView }) {
  return (
    <section className="p2-data-section">
      <div className="p2-data-summary">
        <UsersThree />
        <strong>{competition.division.teamCount}</strong>
        <span>{competition.division.name}</span>
      </div>
      <ol className="p2-team-list">
        {competition.teams.map((team, index) => (
          <li key={team}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{team}</strong>
            <small>{phase2Copy.confirmed}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Capacity({ competition }: { competition: CompetitionView }) {
  return (
    <div className="p2-capacity">
      <section>
        <h2>{phase2Copy.playingAreas}</h2>
        {(competition.capacityAreas ?? []).map((area) => (
          <div key={area.name}>
            <strong>{area.name}</strong>
            <span>{area.availability}</span>
            <small>
              {area.slotCount === null ? phase2Copy.notConfigured : `${area.slotCount} ${phase2Copy.slots}`}
            </small>
          </div>
        ))}
      </section>
      <aside>
        <Gauge />
        <p>{phase2Copy.availableCapacity}</p>
        <strong>{competition.availableCapacity ?? phase2Copy.notConfigured}</strong>
        <span>
          {competition.division.matchCount} {phase2Copy.requiredMatchSlots}
        </span>
        <div>
          <i />
        </div>
        <small>
          {competition.availableCapacity === null || competition.availableCapacity === undefined
            ? phase2Copy.notConfigured
            : `${Math.max(competition.availableCapacity - competition.division.matchCount, 0)} ${phase2Copy.slotsRemain}`}
        </small>
      </aside>
    </div>
  );
}

function Format({ competition }: { competition: CompetitionView }) {
  if (competition.formatSummary?.length === 0) return <SurfaceStatePanel state={phase2Machine.empty} />;
  if (competition.formatSummary) {
    return (
      <dl className="p2-definition-list">
        {competition.formatSummary.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <section className="p2-format" aria-label={t("prototype.675eeee2578b")}>
      <div className="p2-groups">
        <Stage title={phase2Copy.groupA} meta={phase2Copy.fourTeamsSixMatches} />
        <Stage title={phase2Copy.groupB} meta={phase2Copy.fourTeamsSixMatches} />
      </div>
      <span className="p2-format-arrow" aria-hidden="true">
        <ArrowRight />
      </span>
      <Stage title={phase2Copy.semiFinals} meta={phase2Copy.topTwo} />
      <span className="p2-format-arrow" aria-hidden="true">
        <ArrowRight />
      </span>
      <div className="p2-finals">
        <Stage title={phase2Copy.bronzeMatch} meta={phase2Copy.losers} />
        <Stage title={phase2Copy.final} meta={phase2Copy.winners} />
      </div>
    </section>
  );
}

function Schedule({ competition }: { competition: CompetitionView }) {
  return (
    <section className="p2-schedule">
      <div className="p2-schedule__head">
        <span>{phase2Copy.time}</span>
        {competition.areas.map((area) => (
          <strong key={area}>{area}</strong>
        ))}
      </div>
      {(competition.scheduleRows ?? []).map((row) => (
        <div key={row.id}>
          <time>{row.time}</time>
          {row.cells.map((cell, index) => (
            <span key={`${row.id}-${index}`}>{cell || phase2Copy.notConfigured}</span>
          ))}
        </div>
      ))}
    </section>
  );
}

function Publish({ competition }: { competition: CompetitionView }) {
  if (competition.publicationState === "draft") return <SurfaceStatePanel state={phase2Machine.empty} />;
  return (
    <div className="p2-publish">
      <section>
        <span className="p2-published-mark">
          <Check />
        </span>
        <p>{phase2Copy.published}</p>
        <h2>{competition.publishedVersionLabel ?? competition.publicationRevision}</h2>
        <dl>
          <div>
            <dt>{phase2Copy.publishedLabel}</dt>
            <dd>{competition.publishedAt}</dd>
          </div>
          <div>
            <dt>{phase2Copy.results}</dt>
            <dd>{phase2Copy.immediate}</dd>
          </div>
          <div>
            <dt>{phase2Copy.schedule}</dt>
            <dd>{competition.publicationRevision}</dd>
          </div>
        </dl>
        <Link className="p2-button p2-button--dark" href={`/competitions/${competition.slug}`}>
          {phase2Copy.openPublic}
        </Link>
      </section>
      <aside>
        <LockKey />
        <h2>{phase2Copy.readOnlyTitle}</h2>
        <p>{phase2Copy.readOnlyBody}</p>
        <button className="p2-button p2-button--secondary" type="button">
          {phase2Copy.createRevision}
        </button>
      </aside>
    </div>
  );
}

function Access({ competition }: { competition: CompetitionView }) {
  return (
    <AccessPassManager
      competitionId={competition.id}
      matches={competition.matches}
      initialPasses={competition.accessPasses ?? []}
      canEdit={competition.canEdit ?? false}
    />
  );
}

function Audit({ competition }: { competition: CompetitionView }) {
  return (
    <ol className="p2-audit">
      {competition.audit.map((entry) => (
        <li key={`${entry.time}-${entry.action}`}>
          <time>{entry.time}</time>
          <span>
            <strong>{entry.action}</strong>
            <small>{entry.detail}</small>
          </span>
          <span>{entry.actor}</span>
        </li>
      ))}
    </ol>
  );
}

function Field({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <label className={wide ? "p2-field p2-field--wide" : "p2-field"}>
      <span>{label}</span>
      <input defaultValue={value} />
      <small>{phase2Copy.draftSynced}</small>
    </label>
  );
}

function Stage({ title, meta }: { title: string; meta: string }) {
  return (
    <article className="p2-stage">
      <span aria-hidden="true" />
      <h2>{title}</h2>
      <p>{meta}</p>
    </article>
  );
}
