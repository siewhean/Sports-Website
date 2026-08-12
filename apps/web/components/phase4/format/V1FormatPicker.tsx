"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { opaqueId, translate as t } from "@matchday/ui";
import {
  fittingV1Recommendations,
  parseV1FormatApplication,
  parseV1FormatRecommendations,
} from "@/lib/phase4-v1-format-picker";
import type { V1FormatReadiness } from "@/lib/v1-format-readiness";
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
    return "Entries or capacity changed. Complete those setup pages, then return here to choose a format.";
  }
  if (status === 409) return "The competition changed while formats were being prepared. Refresh the page and try again.";
  return error.message ?? copy.prepareError;
}

export function V1FormatPicker({
  competitionId,
  readiness,
  hasAppliedFormat = false,
  advancedHref,
  entriesHref,
  capacityHref,
  scheduleHref,
}: {
  competitionId: string;
  readiness?: V1FormatReadiness;
  hasAppliedFormat?: boolean;
  advancedHref?: string;
  entriesHref?: string;
  capacityHref?: string;
  scheduleHref?: string;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<PickerState>(copy.idle);
  const [document, setDocument] = useState<Phase4SetupDocument | null>(null);
  const [message, setMessage] = useState("");
  const effectiveReadiness = readiness ?? readyByDefault;
  const effectiveEntriesHref = entriesHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/entries`;
  const effectiveCapacityHref = capacityHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/capacity`;
  const effectiveScheduleHref = scheduleHref ?? `/organiser/competitions/${encodeURIComponent(competitionId)}/schedule`;

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

  if (hasAppliedFormat) {
    return (
      <section className={styles.workspace} aria-labelledby="v1-format-selected-heading" data-testid="v1-format-selected">
        <header className={styles.heading}>
          <p className={styles.eyebrow}>Competition format</p>
          <h2 ref={headingRef} id="v1-format-selected-heading" tabIndex={-1}>
            {copy.selectedTitle}
          </h2>
          <p>{copy.selectedBody}</p>
        </header>
        <div className={styles.successPanel} role="status">
          <CheckCircle aria-hidden="true" />
          <div>
            <h3>Fixtures are ready for scheduling</h3>
            <p>Your selected format has been saved and materialised into matches.</p>
          </div>
        </div>
        <div className={styles.actions}>
          <Link className={styles.primaryLink} href={effectiveScheduleHref}>
            Continue to schedule <ArrowRight aria-hidden="true" />
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
      <section className={styles.workspace} aria-labelledby="v1-format-prerequisite-heading" data-testid="v1-format-blocked">
        <header className={styles.heading}>
          <p className={styles.eyebrow}>Competition format</p>
          <h2 id="v1-format-prerequisite-heading">Finish setup before choosing a format</h2>
          <p>MATCHDAY needs your teams and available match capacity before it can recommend a format that actually fits.</p>
        </header>
        <div className={styles.blockedIntro} role="status">
          <WarningCircle aria-hidden="true" />
          <div>
            <h3>Complete the missing setup below</h3>
            <p>You can return to Format as soon as both items are ready. Your existing competition work is kept.</p>
          </div>
        </div>
        <ol className={styles.prerequisiteList} aria-label="Format prerequisites">
          {effectiveReadiness.prerequisites.map((item) => (
            <li className={styles.prerequisiteItem} key={item.id} data-ready={item.ready}>
              <span className={styles.prerequisiteIcon}>{item.ready ? <Check aria-hidden="true" /> : null}</span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
              {item.ready ? null : (
                <Link className={styles.prerequisiteLink} href={linkFor(item.id)}>
                  Go to {item.label} <ArrowRight aria-hidden="true" />
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
        <p className={styles.eyebrow}>Competition format</p>
        <h2 ref={headingRef} id="v1-format-picker-heading" tabIndex={-1}>
          Choose a format that fits your competition
        </h2>
        <p>MATCHDAY uses the entries and playing time you already saved. Review the options, then choose one to create the fixtures used by Schedule.</p>
      </header>

      <div className={styles.readyBar}>
        <div>
          <h3>Entries and capacity are ready</h3>
          <p>Generate only formats that fit the competition information currently saved.</p>
        </div>
        {state === copy.idle || state === copy.loading || state === copy.error ? (
          <button className={styles.primaryButton} type="button" onClick={() => void recommend()} disabled={state === copy.loading}>
            {state === copy.loading ? copy.finding : state === copy.error ? copy.retry : copy.show}
          </button>
        ) : null}
      </div>

      {message ? (
        <p className={state === copy.error ? styles.error : styles.eyebrow} aria-live="polite" role={state === copy.error ? "alert" : "status"}>
          {message}
        </p>
      ) : null}

      {state === copy.ready && options.length === 0 ? <p className={styles.error}>{copy.none}</p> : null}
      {options.length > 0 ? (
        <div>
          <div className={styles.optionsHeader}>
            <div>
              <h3>Available formats</h3>
              <p>Compare match volume and guaranteed play before selecting.</p>
            </div>
          </div>
          <ol className={styles.optionList}>
            {options.map((option, index) => (
              <li className={styles.option} key={option.id}>
                <div>
                  <p className={styles.optionIndex}>Option {index + 1}</p>
                  <h4>{option.name}</h4>
                  <p className={styles.structure}>{option.structure}</p>
                  <p className={styles.advantage}>{option.advantage}</p>
                </div>
                <dl className={styles.metrics}>
                  <div>
                    <dt>Total matches</dt>
                    <dd>{option.match_count}</dd>
                  </div>
                  <div>
                    <dt>Guaranteed / entry</dt>
                    <dd>{option.guaranteed_matches}</dd>
                  </div>
                  <div>
                    <dt>Slots available</dt>
                    <dd>{option.available_match_slots}</dd>
                  </div>
                </dl>
                <button className={styles.primaryButton} type="button" disabled={state === copy.applying} onClick={() => void apply(option.id)}>
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
