"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { UserCircle } from "@phosphor-icons/react";
import { messages } from "@matchday/ui";
import { THEME_CYCLE } from "@/lib/theme";
import { IdentityStatus } from "./IdentityStatus";
import { useThemePreference } from "./ThemeControl";

const copy = messages.organiserShell;

/** Up to two initials from a display name ("Siew Hean" → "SH"). */
export function initialsOf(displayName: string | null): string {
  if (!displayName) return "";
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

/**
 * Account disclosure on the right of the organiser header (redesign Phase 2): who is signed in, the
 * appearance choice (Dark, Light, Same as device) and links out. Opens on click, Enter or Space; Escape or a
 * click outside closes it and returns focus to the button.
 */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [theme, setTheme] = useThemePreference();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const initials = initialsOf(displayName);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        className="account-menu__button"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={copy.account}
        onClick={() => setOpen((value) => !value)}
      >
        {initials ? (
          <span className="account-menu__initials" aria-hidden="true">
            {initials}
          </span>
        ) : (
          <UserCircle aria-hidden="true" size={24} />
        )}
      </button>
      {/* Kept in the DOM while closed so the signed-in name loads once, without waiting for a click. */}
      <div className="account-menu__panel" id={panelId} hidden={!open}>
        <IdentityStatus className="account-menu__identity" onResolved={setDisplayName} />
        <fieldset className="account-menu__theme">
          <legend>{copy.appearance}</legend>
          {THEME_CYCLE.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={`${panelId}-theme`}
                value={option}
                checked={theme === option}
                onChange={() => setTheme(option)}
              />
              {messages.navigation.themes[option]}
            </label>
          ))}
        </fieldset>
        <nav className="account-menu__links" aria-label={copy.account}>
          <Link href="/organiser/competitions">{copy.allCompetitions}</Link>
          <Link href="/account">{copy.accountPage}</Link>
        </nav>
      </div>
    </div>
  );
}
