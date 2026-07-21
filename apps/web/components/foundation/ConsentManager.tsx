"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  CONSENT_STORAGE_KEY,
  createConsentPreferences,
  messages,
  parseConsentPreferences,
  type ConsentPreferences,
} from "@matchday/ui";

const prototypeRoutes = new Set(["/setup", "/format", "/score"]);

export function ConsentManager() {
  const pathname = usePathname();
  const [stored, setStored] = useState<ConsentPreferences | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const preferences = parseConsentPreferences(window.localStorage.getItem(CONSENT_STORAGE_KEY));
      setStored(preferences);
      setAnalytics(preferences?.analytics ?? false);
      setMarketing(preferences?.marketing ?? false);
      setOpen(preferences === null);
    });
    return () => {
      active = false;
    };
  }, []);

  if (prototypeRoutes.has(pathname) || stored === undefined) return null;

  function persist(preferences: Pick<ConsentPreferences, "analytics" | "marketing">) {
    const next = createConsentPreferences(preferences);
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next));
    setStored(next);
    setAnalytics(next.analytics);
    setMarketing(next.marketing);
    setOpen(false);
  }

  return (
    <>
      {stored?.analytics ? <span hidden data-consent-adapter="analytics" /> : null}
      {stored?.marketing ? <span hidden data-consent-adapter="marketing" /> : null}
      {open ? (
        <section className="consent-panel" role="region" aria-labelledby="consent-title">
          <div className="consent-panel__intro">
            <h2 id="consent-title">{messages.consent.title}</h2>
            <p>{messages.consent.body}</p>
            <a href="/cookies">{messages.consent.policy}</a>
          </div>
          <fieldset>
            <legend className="visually-hidden">{messages.consent.title}</legend>
            <div className="consent-panel__choice">
              <span>
                <strong>{messages.consent.essential}</strong>
                <small>{messages.consent.essentialDetail}</small>
              </span>
              <span className="consent-panel__required">{messages.consent.alwaysOn}</span>
            </div>
            <label className="consent-panel__choice">
              <span>
                <strong>{messages.consent.analytics}</strong>
                <small>{messages.consent.analyticsDetail}</small>
              </span>
              <input type="checkbox" checked={analytics} onChange={(event) => setAnalytics(event.target.checked)} />
            </label>
            <label className="consent-panel__choice">
              <span>
                <strong>{messages.consent.marketing}</strong>
                <small>{messages.consent.marketingDetail}</small>
              </span>
              <input type="checkbox" checked={marketing} onChange={(event) => setMarketing(event.target.checked)} />
            </label>
          </fieldset>
          <div className="consent-panel__actions">
            <button type="button" onClick={() => persist({ analytics: false, marketing: false })}>
              {messages.consent.reject}
            </button>
            <button type="button" onClick={() => persist({ analytics, marketing })}>
              {messages.consent.save}
            </button>
            <button className="is-primary" type="button" onClick={() => persist({ analytics: true, marketing: true })}>
              {messages.consent.accept}
            </button>
          </div>
        </section>
      ) : (
        <button className="consent-reopen" type="button" onClick={() => setOpen(true)}>
          {messages.consent.manage}
        </button>
      )}
    </>
  );
}
