"use client";

import Link from "next/link";
import { useState } from "react";
import { interpolate, messages } from "@matchday/ui";
import type { OrganiserCompetitionLibraryItem } from "@/lib/organiser-competition-library";
import { parseEventPassCheckoutUrl } from "@/lib/event-pass-checkout";
import styles from "./EventPassCheckout.module.css";

type Props = Readonly<{
  competitions: readonly OrganiserCompetitionLibraryItem[];
}>;

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

export function EventPassCheckout({ competitions }: Props) {
  const [competitionId, setCompetitionId] = useState(competitions[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [failed, setFailed] = useState(false);

  if (competitions.length === 0) {
    return (
      <div className={styles.empty}>
        <h2>{messages.eventPassCheckout.createCompetitionTitle}</h2>
        <p>{messages.eventPassCheckout.createCompetitionBody}</p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} href="/organiser/competitions/new">
            {messages.eventPassCheckout.createCompetition}
          </Link>
          <Link className={styles.secondaryAction} href="/organiser/competitions">
            {messages.eventPassCheckout.backToCompetitions}
          </Link>
        </div>
      </div>
    );
  }

  async function startCheckout() {
    const selected = competitions.find((competition) => competition.id === competitionId);
    if (!selected || submitting) return;
    setSubmitting(true);
    setFailed(false);
    setStatus(messages.eventPassCheckout.openingSecureCheckout);
    try {
      const response = await fetch("/api/billing/event-pass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId: selected.organisationId, competitionId: selected.id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setFailed(true);
        setStatus(errorMessage(payload) ?? messages.eventPassCheckout.checkoutStartFailed);
        return;
      }
      const checkoutUrl = parseEventPassCheckoutUrl(payload, {
        organisationId: selected.organisationId,
        competitionId: selected.id,
      });
      if (!checkoutUrl) {
        setFailed(true);
        setStatus(messages.eventPassCheckout.invalidCheckoutDestination);
        return;
      }
      window.location.assign(checkoutUrl);
    } catch {
      setFailed(true);
      setStatus(messages.eventPassCheckout.checkoutUnavailable);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.checkout}>
      <section className={styles.panel} aria-labelledby="event-pass-checkout-title">
        <h2 id="event-pass-checkout-title">{messages.eventPassCheckout.chooseCompetition}</h2>
        <p>{messages.eventPassCheckout.scopeDescription}</p>
        <div className={styles.field}>
          <label htmlFor="event-pass-competition">{messages.eventPassCheckout.competitionLabel}</label>
          <select
            className={styles.select}
            id="event-pass-competition"
            value={competitionId}
            onChange={(event) => setCompetitionId(event.target.value)}
            disabled={submitting}
          >
            {competitions.map((competition) => (
              <option key={competition.id} value={competition.id}>
                {interpolate(messages.eventPassCheckout.competitionOption, {
                  competition: competition.name,
                  organisation: competition.organisationName,
                  startsOn: competition.startsOn,
                  endsOn: competition.endsOn,
                })}
              </option>
            ))}
          </select>
          <span className={styles.help}>{messages.eventPassCheckout.paymentReview}</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.primaryAction} type="button" onClick={startCheckout} disabled={submitting}>
            {submitting
              ? messages.eventPassCheckout.openingCheckout
              : messages.eventPassCheckout.continueToSecureCheckout}
          </button>
          <Link className={styles.secondaryAction} href="/pricing">
            {messages.eventPassCheckout.backToPricing}
          </Link>
        </div>
        <div className={styles.status} data-error={failed ? "true" : "false"} aria-live="polite">
          {status}
        </div>
      </section>
    </div>
  );
}
