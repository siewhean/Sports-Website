"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { messages, opaqueId, translate as t } from "@matchday/ui";
import { InfoTip } from "@matchday/ui/react";
import {
  fittingV1Recommendations,
  parseV1FormatApplication,
  parseV1FormatRecommendations,
} from "@/lib/phase4-v1-format-picker";
import type { V1FormatReadiness } from "@/lib/v1-format-readiness";
import {
  detectFormatFamily,
  formatDescriptiveTitle,
  formatFitStatus,
  formatRecommendationRibbon,
} from "@/lib/format-copy";
import { FormatPreviewDiagram } from "./FormatPreviewDiagram";
import styles from "./V1FormatPicker.module.css";

type PickerState = "idle" | "loading" | "ready" | "applying" | "error";
const readyByDefault: V1FormatReadiness = { ready: true, prerequisites: [] };
const copy = {
  idle: opaqueId("idle"),
  loading: opaqueId("loading"),
  ready: opaqueId("ready"),
  applying: opaqueId("applying"),
  error: opaqueId("error"),
  post: opaqueId("POST"),
  json: opaqueId("application/json"),
  prepareError: t("prototype.133d0cd6b7fb"),
  optionsReady: t("prototype.cbc3f7044f8b"),
  applyError: t("prototype.0533fc01a330"),
  applied: t("prototype.fc509d65d222"),
  selectedTitle: t("prototype.401665b38dd7"),
  selectedBody: t("prototype.987babcd922c"),
  advanced: t("prototype.066a54319cfb"),
  finding: t("prototype.7c88d61058c9"),
  show: t("prototype.01f27222b25f"),
  retry: t("prototype.d8b8392e2c54"),
  none: t("prototype.028141a64b8d"),
  applyingLabel: t("prototype.c2c8f03c0e21"),
  apply: t("prototype.f83bcedd3aa7"),
  prerequisitesChanged: t("prototype.534727adcf70"),
  preparationChanged: t("prototype.21188b3c83ff"),
  format: t("prototype.675eeee2578b"),
  fixturesReady: t("prototype.3a0616051748"),
  materialised: t("prototype.372d1baf3b68"),
  continueToSchedule: t("prototype.3cdacc08fd08"),
  finishSetup: t("prototype.380508dcb9bf"),
  readinessBody: t("prototype.f8a571bb1fc5"),
  completeSetup: t("prototype.52227c712366"),
  returnToFormat: t("prototype.b84dcbc3e1e3"),
  prerequisites: t("prototype.8d478bc40b3d"),
  goTo: t("prototype.a8aa078b7ea6"),
  pickerTitle: t("prototype.8edfbae782e1"),
  pickerBody: t("prototype.ae122944be4b"),
  readyTitle: t("prototype.0368c23692fd"),
  readyBody: t("prototype.6650f3b35035"),
  availableFormats: t("prototype.33811c2dbd9e"),
  availableFormatsBody: t("prototype.f2817b90af81"),
  option: t("prototype.45aaacba7ea1"),
  totalMatches: t("prototype.b556e5c45b4e"),
  guaranteedMatches: t("prototype.4b9c79ade388"),
  availableSlots: t("prototype.b35e91492eb6"),
  schedule: t("prototype.f4830a1dae29"),
  scheduleFeasible: opaqueId("Fits the schedule"),
  scheduleNotChecked: opaqueId("Not checked"),
  rulesSuggestion: opaqueId("Rules-based suggestion"),
  division: opaqueId("Division"),
  formatFor: (name: string) => opaqueId(`Format for ${name}`),
  formatSubhead: (teamCount: number, availableSlots: number, otherDivisionsText: string) =>
    opaqueId(
      `${teamCount} team${teamCount === 1 ? "" : "s"}. Here are three ways to run it, checked against your venue time (${availableSlots} match slots${otherDivisionsText}).`,
    ),
  fitsVenueTime: opaqueId("Fits the venue time"),
  doesNotFit: opaqueId("Doesn’t fit"),
  matches: opaqueId("Matches"),
  fewestGames: opaqueId("Fewest games for a team"),
  slotsUsed: opaqueId("Slots used"),
  slotsUsedBoth: opaqueId("Slots used (both divisions)"),
  slotsUsedAll: opaqueId("Slots used (all divisions)"),
  everyTeamRanked: opaqueId("Every team ranked"),
  yes: opaqueId("Yes"),
  no: opaqueId("No"),
  useThisFormat: opaqueId("Use this format"),
  currentFormat: opaqueId("Current format"),
  customise: opaqueId("Customise"),
  designYourOwn: opaqueId("Design your own"),
  somethingElse: opaqueId("Something else in mind?"),
  blankPageText: opaqueId(
    "Start from a blank page: add groups, knockouts, double elimination or placement matches yourself.",
  ),
} as const;

function errorDetails(payload: unknown): { code: string | null; message: string | null } {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return { code: null, message: null };
  const error = payload.error;
  if (!error || typeof error !== "object") return { code: null, message: null };
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : null,
    message: "message" in error && typeof error.message === "string" ? error.message : null,
  };
}

function recommendationError(status: number, payload: unknown): string {
  const error = errorDetails(payload);
  if (error.code === "FORMAT_PREREQUISITE_MISSING" || error.code === "SETUP_PREREQUISITE_MISSING") {
    return copy.prerequisitesChanged;
  }
  if (status === 409) return copy.preparationChanged;
  return error.message ?? copy.prepareError;
}

export type V1FormatPickerDivision = {
  readonly id: string;
  readonly name: string;
  readonly entryCount?: number;
};

export type V1FormatPickerProps = {
  readonly competitionId: string;
  readonly readiness?: V1FormatReadiness;
  readonly hasAppliedFormat?: boolean;
  readonly advancedHref?: string;
  readonly entriesHref?: string;
  readonly capacityHref?: string;
  readonly scheduleHref?: string;
  readonly divisions?: readonly V1FormatPickerDivision[];
  readonly initialDivisionId?: string;
  readonly initialDocument?: Phase4SetupDocument | null;
  readonly isRedesignP5CardsEnabled?: boolean;
};

export function V1FormatPicker({
  competitionId,
  readiness,
  hasAppliedFormat = false,
  advancedHref,
  entriesHref,
  capacityHref,
  scheduleHref,
  divisions,
  initialDivisionId,
  initialDocument,
  isRedesignP5CardsEnabled = false,
}: V1FormatPickerProps) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<PickerState>(copy.idle);
  const [document, setDocument] = useState<Phase4SetupDocument | null>(initialDocument ?? null);
  const [activeDivisionId, setActiveDivisionId] = useState<string>(initialDivisionId ?? divisions?.[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const effectiveReadiness = readiness ?? readyByDefault;
  const effectiveEntriesHref = entriesHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/entries`;
  const effectiveCapacityHref = capacityHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/capacity`;
  const effectiveScheduleHref = scheduleHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/schedule`;

  const isRedesignCards =
    isRedesignP5CardsEnabled ||
    (typeof window !== "undefined" && window.document.cookie.includes("matchday-redesign-p5-cards=1"));

  const recommend = async () => {
    if (!effectiveReadiness.ready) return;
    setState(copy.loading);
    setMessage("");
    try {
      const response = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(competitionId)}/v1-format-recommendations`,
        {
          method: copy.post,
          headers: { "content-type": copy.json },
          body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(recommendationError(response.status, payload));
      const next = parseV1FormatRecommendations(payload, competitionId);
      if (!next) throw new Error(copy.prepareError);
      setDocument(next);
      setState(copy.ready);
      setMessage(copy.optionsReady);
    } catch (error) {
      setState(copy.error);
      setMessage(error instanceof Error ? error.message : copy.prepareError);
    }
  };

  const apply = async (recommendationId: string) => {
    setState(copy.applying);
    setMessage("");
    try {
      const response = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(competitionId)}/v1-format-recommendations/${encodeURIComponent(recommendationId)}/apply`,
        {
          method: copy.post,
          headers: { "content-type": copy.json },
          body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorDetails(payload).message ?? copy.applyError);
      const applied = parseV1FormatApplication(payload, competitionId);
      if (!applied) throw new Error(copy.applyError);
      setDocument(applied.document);
      setState(copy.ready);
      setMessage(copy.applied);
      router.refresh();
      setTimeout(() => headingRef.current?.focus(), 0);
    } catch (error) {
      setState(copy.ready);
      setMessage(error instanceof Error ? error.message : copy.applyError);
    }
  };

  const options = document ? fittingV1Recommendations(document) : [];
  const linkFor = (id: "entries" | "capacity") => (id === "entries" ? effectiveEntriesHref : effectiveCapacityHref);

  if (isRedesignCards) {
    if (!effectiveReadiness.ready) {
      return (
        <section
          className={styles.workspace}
          aria-labelledby="v1-format-prerequisite-heading"
          data-testid="v1-format-blocked"
        >
          <header className={styles.heading}>
            <p className={styles.eyebrow}>{copy.format}</p>
            <h2 id="v1-format-prerequisite-heading">{copy.finishSetup}</h2>
            <p>{copy.readinessBody}</p>
          </header>
          <div className={styles.blockedIntro} role="status">
            <WarningCircle aria-hidden="true" />
            <div>
              <h3>{copy.completeSetup}</h3>
              <p>{copy.returnToFormat}</p>
            </div>
          </div>
          <ol className={styles.prerequisiteList} aria-label={copy.prerequisites}>
            {effectiveReadiness.prerequisites.map((item) => (
              <li className={styles.prerequisiteItem} key={item.id} data-ready={item.ready}>
                <span className={styles.prerequisiteIcon}>{item.ready ? <Check aria-hidden="true" /> : null}</span>
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
                {item.ready ? null : (
                  <Link className={styles.prerequisiteLink} href={linkFor(item.id)}>
                    {copy.goTo} {item.label} <ArrowRight aria-hidden="true" />
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      );
    }

    const activeDivision = divisions?.find((d) => d.id === activeDivisionId) ??
      divisions?.[0] ?? { id: "", name: opaqueId("Main"), entryCount: 12 };
    const otherDivisions = divisions?.filter((d) => d.id !== activeDivision.id) ?? [];

    const recommendationSet = document?.values?.format_recommendations;
    const normalRecs = recommendationSet?.recommendations ?? [];
    const requiresChanges = recommendationSet?.requires_changes ?? null;
    const candidates = [...normalRecs, ...(requiresChanges ? [requiresChanges] : [])].slice(0, 3);

    const firstCandidate = candidates[0];
    let otherDivisionsText = "";
    if (firstCandidate && otherDivisions.length === 1) {
      const otherDiv = otherDivisions[0]!;
      const otherDivisionFormat = firstCandidate.division_formats.find((df) => df.division_id === otherDiv.id);
      if (otherDivisionFormat) {
        otherDivisionsText = `, with ${otherDiv.name} already using ${otherDivisionFormat.match_count}`;
      }
    } else if (firstCandidate && otherDivisions.length > 1) {
      const otherSlotsTotal = otherDivisions.reduce((sum, d) => {
        const df = firstCandidate.division_formats.find((item) => item.division_id === d.id);
        return sum + (df?.match_count ?? 0);
      }, 0);
      if (otherSlotsTotal > 0) {
        otherDivisionsText = `, with other divisions using ${otherSlotsTotal}`;
      }
    }

    const slotsUsedLabel =
      divisions && divisions.length === 2
        ? copy.slotsUsedBoth
        : divisions && divisions.length > 2
          ? copy.slotsUsedAll
          : copy.slotsUsed;

    const totalAvailableSlots = firstCandidate?.available_match_slots ?? 0;

    return (
      <section className={styles.workspace} aria-labelledby="v1-format-picker-heading" data-testid="v1-format-picker">
        <header className={styles.pageHeader}>
          <div className={styles.pageHeaderInfo}>
            <h1 ref={headingRef} id="v1-format-picker-heading" tabIndex={-1}>
              {copy.formatFor(activeDivision.name)}
            </h1>
            <p>{copy.formatSubhead(activeDivision.entryCount ?? 12, totalAvailableSlots, otherDivisionsText)}</p>
          </div>
          {divisions && divisions.length > 1 ? (
            <div className={styles.divisionSegmented} role="group" aria-label={copy.division}>
              {divisions.map((div) => (
                <button
                  key={div.id}
                  className={styles.divisionButton}
                  type="button"
                  aria-pressed={div.id === activeDivision.id}
                  onClick={() => setActiveDivisionId(div.id)}
                >
                  {`${div.name} · ${div.entryCount ?? 0}`}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {candidates.length === 0 ? (
          <div className={styles.readyBar}>
            <div>
              <h3>{copy.readyTitle}</h3>
              <p>{copy.readyBody}</p>
            </div>
            {state === copy.idle || state === copy.loading || state === copy.error ? (
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void recommend()}
                disabled={state === copy.loading}
              >
                {state === copy.loading ? copy.finding : state === copy.error ? copy.retry : copy.show}
              </button>
            ) : null}
          </div>
        ) : null}

        {message ? (
          <p
            className={state === copy.error ? styles.error : styles.eyebrow}
            aria-live="polite"
            role={state === copy.error ? "alert" : "status"}
          >
            {message}
          </p>
        ) : null}

        {candidates.length > 0 ? (
          <div className={styles.cardsGrid}>
            {candidates.map((candidate, index) => {
              const family = detectFormatFamily({
                strategy: candidate.name,
                name: candidate.name,
                structure: candidate.structure,
              });
              const ribbon = formatRecommendationRibbon(family, index + 1);
              const title = formatDescriptiveTitle(family, activeDivision.entryCount ?? 12);
              const divisionFormat =
                candidate.division_formats.find((df) => df.division_id === activeDivision.id) ??
                candidate.division_formats[0];
              const fitInfo = formatFitStatus(candidate);
              const isPicked = document?.values?.format_recommendations?.selected_recommendation_id === candidate.id;
              const customiseHref =
                advancedHref ??
                `/organiser/competitions/${encodeURIComponent(competitionId)}/format?division=${encodeURIComponent(activeDivision.id)}&mode=editor`;

              return (
                <article
                  key={candidate.id}
                  className={`${styles.formatCard} ${isPicked ? styles.formatCardSelected : ""}`}
                >
                  <span className={`${styles.cardRibbon} ${ribbon.isBest ? styles.cardRibbonBest : ""}`}>
                    {ribbon.label}
                  </span>
                  <h2 className={styles.cardTitle}>{title}</h2>
                  <div className={styles.cardPreview}>
                    <FormatPreviewDiagram strategy={family} entryCount={activeDivision.entryCount ?? 12} />
                  </div>
                  <dl className={styles.cardMetrics}>
                    <div>
                      <dt>{copy.matches}</dt>
                      <dd>{divisionFormat ? divisionFormat.match_count : candidate.match_count}</dd>
                    </div>
                    <div>
                      <dt>{copy.fewestGames}</dt>
                      <dd>{divisionFormat ? divisionFormat.guaranteed_matches : candidate.guaranteed_matches}</dd>
                    </div>
                    <div>
                      <dt>{slotsUsedLabel}</dt>
                      <dd>{`${candidate.match_count} / ${candidate.available_match_slots}`}</dd>
                    </div>
                    <div>
                      <dt>{copy.everyTeamRanked}</dt>
                      <dd>{candidate.ranking_coverage === "all_entries" ? copy.yes : copy.no}</dd>
                    </div>
                  </dl>
                  <span className={`${styles.badge} ${fitInfo.fits ? styles.badgeFits : styles.badgeNoFit}`}>
                    {fitInfo.badgeLabel}
                  </span>
                  <p className={styles.cardWhy}>{`${fitInfo.reason}${fitInfo.fix ? ` ${fitInfo.fix}` : ""}`}</p>
                  <div className={styles.cardActions}>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      data-pick={candidate.name}
                      aria-pressed={isPicked}
                      disabled={state === copy.applying || !fitInfo.fits}
                      onClick={() => void apply(candidate.id)}
                    >
                      {state === copy.applying && isPicked
                        ? copy.applyingLabel
                        : isPicked
                          ? copy.currentFormat
                          : copy.useThisFormat}
                    </button>
                    <Link className={styles.secondaryLink} href={customiseHref}>
                      {copy.customise}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        <div className={styles.designOwnSheet}>
          <div>
            <h2>{copy.somethingElse}</h2>
            <p>{copy.blankPageText}</p>
          </div>
          <Link
            className={styles.secondaryLink}
            href={
              advancedHref ??
              `/organiser/competitions/${encodeURIComponent(competitionId)}/format?division=${encodeURIComponent(activeDivision.id)}&mode=editor`
            }
          >
            {copy.designYourOwn}
          </Link>
        </div>
      </section>
    );
  }

  if (hasAppliedFormat) {
    return (
      <section
        className={styles.workspace}
        aria-labelledby="v1-format-selected-heading"
        data-testid="v1-format-selected"
      >
        <header className={styles.heading}>
          <p className={styles.eyebrow}>{copy.format}</p>
          <h2 ref={headingRef} id="v1-format-selected-heading" tabIndex={-1}>
            {copy.selectedTitle}
          </h2>
          <p>{copy.selectedBody}</p>
        </header>
        <div className={styles.successPanel} role="status">
          <CheckCircle aria-hidden="true" />
          <div>
            <h3>{copy.fixturesReady}</h3>
            <p>{copy.materialised}</p>
          </div>
        </div>
        <div className={styles.actions}>
          <Link className={styles.primaryLink} href={effectiveScheduleHref}>
            {copy.continueToSchedule} <ArrowRight aria-hidden="true" />
          </Link>
          {advancedHref ? (
            <Link className={styles.secondaryLink} href={advancedHref}>
              {copy.advanced}
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  if (!effectiveReadiness.ready) {
    return (
      <section
        className={styles.workspace}
        aria-labelledby="v1-format-prerequisite-heading"
        data-testid="v1-format-blocked"
      >
        <header className={styles.heading}>
          <p className={styles.eyebrow}>{copy.format}</p>
          <h2 id="v1-format-prerequisite-heading">{copy.finishSetup}</h2>
          <p>{copy.readinessBody}</p>
        </header>
        <div className={styles.blockedIntro} role="status">
          <WarningCircle aria-hidden="true" />
          <div>
            <h3>{copy.completeSetup}</h3>
            <p>{copy.returnToFormat}</p>
          </div>
        </div>
        <ol className={styles.prerequisiteList} aria-label={copy.prerequisites}>
          {effectiveReadiness.prerequisites.map((item) => (
            <li className={styles.prerequisiteItem} key={item.id} data-ready={item.ready}>
              <span className={styles.prerequisiteIcon}>{item.ready ? <Check aria-hidden="true" /> : null}</span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
              {item.ready ? null : (
                <Link className={styles.prerequisiteLink} href={linkFor(item.id)}>
                  {copy.goTo} {item.label} <ArrowRight aria-hidden="true" />
                </Link>
              )}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section className={styles.workspace} aria-labelledby="v1-format-picker-heading" data-testid="v1-format-picker">
      <header className={styles.heading}>
        <p className={styles.eyebrow}>{copy.format}</p>
        <div className="md-label-row md-label-row--heading">
          <h2 ref={headingRef} id="v1-format-picker-heading" tabIndex={-1}>
            {copy.pickerTitle}
          </h2>
          <InfoTip label={`${messages.organiser.moreAbout} ${copy.pickerTitle.toLowerCase()}`}>
            {copy.pickerBody}
          </InfoTip>
        </div>
      </header>

      <div className={styles.readyBar}>
        <div>
          <h3>{copy.readyTitle}</h3>
          <p>{copy.readyBody}</p>
        </div>
        {state === copy.idle || state === copy.loading || state === copy.error ? (
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => void recommend()}
            disabled={state === copy.loading}
          >
            {state === copy.loading ? copy.finding : state === copy.error ? copy.retry : copy.show}
          </button>
        ) : null}
      </div>

      {message ? (
        <p
          className={state === copy.error ? styles.error : styles.eyebrow}
          aria-live="polite"
          role={state === copy.error ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}

      {state === copy.ready && options.length === 0 ? <p className={styles.error}>{copy.none}</p> : null}
      {options.length > 0 ? (
        <div>
          <div className={styles.optionsHeader}>
            <div>
              <div className="md-label-row md-label-row--heading">
                <h3>{copy.availableFormats}</h3>
                <InfoTip label={`${messages.organiser.moreAbout} ${copy.availableFormats.toLowerCase()}`}>
                  {copy.availableFormatsBody}
                </InfoTip>
              </div>
            </div>
          </div>
          <ol className={styles.optionList}>
            {options.map((option, index) => (
              <li className={styles.option} key={option.id}>
                <div>
                  <p className={styles.optionIndex}>
                    {copy.option} {index + 1} · {copy.rulesSuggestion}
                  </p>
                  <h4>{option.name}</h4>
                  <p className={styles.structure}>{option.structure}</p>
                  <p className={styles.advantage}>{option.advantage}</p>
                </div>
                <dl className={styles.metrics}>
                  <div>
                    <dt>{copy.totalMatches}</dt>
                    <dd>{option.match_count}</dd>
                  </div>
                  <div>
                    <dt>{copy.guaranteedMatches}</dt>
                    <dd>{option.guaranteed_matches}</dd>
                  </div>
                  <div>
                    <dt>{copy.availableSlots}</dt>
                    <dd>{option.available_match_slots}</dd>
                  </div>
                  <div>
                    <dt>{copy.schedule}</dt>
                    {/* Infeasible options are filtered out above, so only these two remain. */}
                    <dd data-scheduling-status={option.scheduling_status}>
                      {option.scheduling_status === "feasible" ? copy.scheduleFeasible : copy.scheduleNotChecked}
                    </dd>
                  </div>
                </dl>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={state === copy.applying}
                  onClick={() => void apply(option.id)}
                >
                  {state === copy.applying ? copy.applyingLabel : copy.apply}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
