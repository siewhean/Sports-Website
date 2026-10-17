"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "@phosphor-icons/react";
import { messages, opaqueId } from "@matchday/ui";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  nextThemePreference,
  parseThemePreference,
  type ThemePreference,
} from "@/lib/theme";

/** Applies a theme now and saves it for the pre-paint script in app/layout.tsx (no flash on the next load). */
export function applyThemePreference(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the choice still applies for this visit.
  }
}

/** The current theme preference, read after hydration so server and client markup match. */
export function useThemePreference(): [ThemePreference, (theme: ThemePreference) => void] {
  // The server always renders the default; the real choice is read after hydration so markup matches.
  const [theme, setTheme] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    let mounted = true;
    const current = parseThemePreference(document.documentElement.dataset.theme);
    queueMicrotask(() => {
      if (mounted) setTheme(current);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return [
    theme,
    (next) => {
      setTheme(next);
      applyThemePreference(next);
    },
  ];
}

/**
 * Cycles Dark (default) → Light → Same as device. The choice is applied to <html data-theme> immediately and
 * saved to localStorage, which the pre-paint script in app/layout.tsx reads on the next load (no flash).
 */
export function ThemeControl() {
  const [theme, setTheme] = useThemePreference();
  const nextTheme = nextThemePreference(theme);
  return (
    <button
      className="theme-control"
      type="button"
      data-theme-preference={theme}
      onClick={() => setTheme(nextTheme)}
      aria-label={`${messages.navigation.theme}: ${messages.navigation.themes[theme]}. ${messages.navigation.themeNext}: ${messages.navigation.themes[nextTheme]}`}
      title={`${messages.navigation.theme}: ${messages.navigation.themes[theme]}`}
    >
      <span aria-hidden="true" className="theme-control__glyph">
        {theme === opaqueId("dark") ? <Moon /> : theme === opaqueId("light") ? <Sun /> : <Monitor />}
      </span>
      <span className="theme-control__label">{messages.navigation.themes[theme]}</span>
    </button>
  );
}
