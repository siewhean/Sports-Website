import { designTokens } from "@matchday/ui";

/**
 * Theme preference (owner decision D10): Light, Dark or Same as device, default Dark.
 *
 * The server always renders data-theme="dark": public documents must be identical for every visitor (they are
 * service-worker cached, see lib/public-routes.ts), so the HTML never varies by cookie. A tiny blocking script in
 * <head> applies a saved choice from localStorage before first paint, so there is no flash of the wrong theme.
 */
export type ThemePreference = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "matchday-theme";
export const DEFAULT_THEME = "dark" satisfies ThemePreference;
/** Cycle order of the theme button, starting from the default. */
export const THEME_CYCLE: readonly ThemePreference[] = ["dark", "light", "system"];

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

/** Browser chrome colour for a preference; "system" depends on the device and is resolved by the caller. */
export function themeColorFor(resolved: "dark" | "light"): string {
  return designTokens.themeColor[resolved];
}

/**
 * Source of the pre-paint script. Kept dependency-free and small; it runs before React. It sets
 * <html data-theme>, then keeps <meta name="theme-color"> in step (including device changes for "system").
 */
export function themeBootstrapScript(): string {
  const config = JSON.stringify({
    key: THEME_STORAGE_KEY,
    fallback: DEFAULT_THEME,
    dark: designTokens.themeColor.dark,
    light: designTokens.themeColor.light,
  });
  return `(function(c){var d=document.documentElement,t=c.fallback;try{var s=localStorage.getItem(c.key);if(s==="light"||s==="dark"||s==="system")t=s}catch(e){}d.setAttribute("data-theme",t);var q=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");function r(){var p=d.getAttribute("data-theme");return p==="system"?(q&&q.matches?"dark":"light"):p==="light"?"light":"dark"}function m(){var e=document.querySelector('meta[name="theme-color"]');if(e)e.setAttribute("content",c[r()])}m();document.addEventListener("DOMContentLoaded",m);if(q&&q.addEventListener)q.addEventListener("change",m);new MutationObserver(m).observe(d,{attributes:true,attributeFilter:["data-theme"]})})(${config});`;
}
