"use client";

import { useState, useSyncExternalStore } from "react";
import { messages } from "@matchday/ui";
import styles from "./CookieConsentBanner.module.css";

const CONSENT_STORAGE_KEY = "matchday_cookie_consent";

const consentKind = {
  all: "all",
  essential: "essential",
} as const;

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot() {
  try {
    return Boolean(localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return true;
  }
}

function getServerSnapshot() {
  return true;
}

export function CookieConsentBanner() {
  const hasConsent = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  const handleChoice = (choice: "all" | "essential") => {
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ choice, timestamp: new Date().toISOString() }));
    } catch {
      // Ignore
    }
    setDismissed(true);
  };

  if (hasConsent || dismissed) return null;

  return (
    <aside
      className={styles.banner}
      role="region"
      aria-label={messages.legal.cookieConsentAriaLabel}
      data-testid="cookie-consent-banner"
    >
      <div className={styles.content}>
        <div className={styles.title}>{messages.legal.cookieConsentTitle}</div>
        <p className={styles.text}>{messages.legal.cookieConsentBody}</p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.buttonSecondary}
          onClick={() => handleChoice(consentKind.essential)}
          data-testid="cookie-consent-essential"
        >
          {messages.legal.cookieConsentDecline}
        </button>
        <button
          type="button"
          className={styles.buttonPrimary}
          onClick={() => handleChoice(consentKind.all)}
          data-testid="cookie-consent-accept"
        >
          {messages.legal.cookieConsentAccept}
        </button>
      </div>
    </aside>
  );
}
