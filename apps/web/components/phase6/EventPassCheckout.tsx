"use client";

import Link from "next/link";
import { useState } from "react";
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
        <h2>Create a competition first</h2>
        <p>An Event Pass is tied to one named competition, so there needs to be a competition to attach it to.</p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} href="/organiser/new">
            Create competition
          </Link>
          <Link className={styles.secondaryAction} href="/organiser/competitions">
            Back to my competitions
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
    setStatus("Opening secure checkout…");
    try {
      const response = await fetch("/api/billing/event-pass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId: selected.organisationId, competitionId: selected.id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setFailed(true);
        setStatus(errorMessage(payload) ?? "Checkout could not be started. No charge was made.");
        return;
      }
      const checkoutUrl = parseEventPassCheckoutUrl(payload, {
        organisationId: selected.organisationId,
        competitionId: selected.id,
      });
      if (!checkoutUrl) {
        setFailed(true);
        setStatus("Checkout returned an invalid destination. No charge was made.");
        return;
      }
      window.location.assign(checkoutUrl);
    } catch {
      setFailed(true);
      setStatus("Checkout is temporarily unavailable. No charge was made.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.checkout}>
      <section className={styles.panel} aria-labelledby="event-pass-checkout-title">
        <h2 id="event-pass-checkout-title">Choose the competition</h2>
        <p>
          The $49 Event Pass unlocks paid competition features for the selected event only. Other competitions in the same
          organisation keep their own entitlement level.
        </p>
        <div className={styles.field}>
          <label htmlFor="event-pass-competition">Competition</label>
          <select
            className={styles.select}
            id="event-pass-competition"
            value={competitionId}
            onChange={(event) => setCompetitionId(event.target.value)}
            disabled={submitting}
          >
            {competitions.map((competition) => (
              <option key={competition.id} value={competition.id}>
                {competition.name} — {competition.organisationName} ({competition.startsOn} to {competition.endsOn})
              </option>
            ))}
          </select>
          <span className={styles.help}>You can review the charge and payment details on Stripe before paying.</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.primaryAction} type="button" onClick={startCheckout} disabled={submitting}>
            {submitting ? "Opening checkout…" : "Continue to secure checkout"}
          </button>
          <Link className={styles.secondaryAction} href="/pricing">
            Back to pricing
          </Link>
        </div>
        <div className={styles.status} data-error={failed ? "true" : "false"} aria-live="polite">
          {status}
        </div>
      </section>
    </div>
  );
}
