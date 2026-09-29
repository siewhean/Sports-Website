"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "@phosphor-icons/react";
import { messages, opaqueId } from "@matchday/ui";

type Theme = "system" | "light" | "dark";
const themes: Theme[] = [opaqueId("system"), opaqueId("light"), opaqueId("dark")];
const storageKey = "matchday-theme";

export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(opaqueId("system"));

  useEffect(() => {
    let mounted = true;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === opaqueId("light") || saved === opaqueId("dark")) {
        queueMicrotask(() => {
          if (mounted) setTheme(saved);
        });
      }
    } catch {
      // The system preference remains usable when storage is unavailable.
    }
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const nextTheme = themes[(themes.indexOf(theme) + 1) % themes.length];
  return (
    <button
      className="theme-control"
      type="button"
      onClick={() => {
        setTheme(nextTheme);
        try {
          window.localStorage.setItem(storageKey, nextTheme);
        } catch {
          // Visual preference still changes for this visit.
        }
      }}
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
