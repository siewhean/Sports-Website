"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { opaqueId, translate as t } from "@matchday/ui";
import {
  fittingV1Recommendations,
  parseV1FormatApplication,
  parseV1FormatRecommendations,
} from "@/lib/phase4-v1-format-picker";

type PickerState = "idle" | "loading" | "ready" | "applying" | "error";
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
  title: t("prototype.09d81fb45d7f"),
  intro: t("prototype.428e830191c0"),
  finding: t("prototype.7c88d61058c9"),
  show: t("prototype.01f27222b25f"),
  retry: t("prototype.d8b8392e2c54"),
  none: t("prototype.028141a64b8d"),
  matches: t("prototype.2b082ff09bf8"),
  guaranteed: t("prototype.236a82b0edb1"),
  slots: t("prototype.069d05955c89"),
  applyingLabel: t("prototype.c2c8f03c0e21"),
  apply: t("prototype.f83bcedd3aa7"),
} as const;

export function V1FormatPicker({
  competitionId,
  hasAppliedFormat = false,
  advancedHref,
}: {
  competitionId: string;
  hasAppliedFormat?: boolean;
  advancedHref?: string;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<PickerState>(copy.idle);
  const [document, setDocument] = useState<Phase4SetupDocument | null>(null);
  const [message, setMessage] = useState("");
  const recommend = async () => {
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
      const next = parseV1FormatRecommendations(await response.json().catch(() => null), competitionId);
      if (!response.ok || !next) throw new Error(copy.prepareError);
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
      const applied = parseV1FormatApplication(await response.json().catch(() => null), competitionId);
      if (!response.ok || !applied) throw new Error(copy.applyError);
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
  if (hasAppliedFormat)
    return (
      <section aria-labelledby="v1-format-selected-heading" data-testid="v1-format-selected">
        <h2 id="v1-format-selected-heading">{copy.selectedTitle}</h2>
        <p>{copy.selectedBody}</p>
        {advancedHref ? <Link href={advancedHref}>{copy.advanced}</Link> : null}
      </section>
    );
  return (
    <section aria-labelledby="v1-format-picker-heading" data-testid="v1-format-picker">
      <h2 ref={headingRef} id="v1-format-picker-heading" tabIndex={-1}>
        {copy.title}
      </h2>
      <p>{copy.intro}</p>
      <p aria-live="polite" role="status">
        {message}
      </p>
      {state === copy.idle || state === copy.loading ? (
        <button type="button" onClick={recommend} disabled={state === copy.loading}>
          {state === copy.loading ? copy.finding : copy.show}
        </button>
      ) : null}
      {state === copy.error ? (
        <button type="button" onClick={recommend}>
          {copy.retry}
        </button>
      ) : null}
      {state === copy.ready && options.length === 0 ? <p>{copy.none}</p> : null}
      {options.length > 0 ? (
        <ul>
          {options.map((option) => (
            <li key={option.id}>
              <h3>{option.name}</h3>
              <p>{option.structure}</p>
              <p>
                {option.match_count} {copy.matches} {option.guaranteed_matches} {copy.guaranteed}{" "}
                {option.available_match_slots} {copy.slots}
              </p>
              <p>{option.advantage}</p>
              <button type="button" disabled={state === copy.applying} onClick={() => apply(option.id)}>
                {state === copy.applying ? copy.applyingLabel : copy.apply}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
