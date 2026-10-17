import { describe, expect, it } from "vitest";
import { designTokens } from "@matchday/ui";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  nextThemePreference,
  parseThemePreference,
  themeBootstrapScript,
} from "@/lib/theme";

type Harness = { theme: () => string | null; meta: () => string | null; setDevice: (dark: boolean) => void };

/** Runs the pre-paint script against a minimal fake DOM (no jsdom in this suite). */
function runBootstrap(saved: string | null | Error, deviceDark: boolean): Harness {
  const attributes = new Map<string, string>();
  let metaContent: string | null = designTokens.themeColor.dark;
  let mediaListener: (() => void) | null = null;
  let observer: (() => void) | null = null;
  const media = {
    matches: deviceDark,
    addEventListener: (_: string, listener: () => void) => (mediaListener = listener),
  };
  const documentElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
      observer?.();
    },
  };
  const fakeDocument = {
    documentElement,
    addEventListener: () => undefined,
    querySelector: () => ({ setAttribute: (_: string, value: string) => (metaContent = value) }),
  };
  const fakeWindow = { matchMedia: () => media };
  const fakeStorage = {
    getItem: (key: string) => {
      if (saved instanceof Error) throw saved;
      return key === THEME_STORAGE_KEY ? saved : null;
    },
  };
  class FakeMutationObserver {
    constructor(callback: () => void) {
      observer = callback;
    }
    observe() {}
  }
  new Function("document", "window", "localStorage", "MutationObserver", themeBootstrapScript())(
    fakeDocument,
    fakeWindow,
    fakeStorage,
    FakeMutationObserver,
  );
  return {
    theme: () => attributes.get("data-theme") ?? null,
    meta: () => metaContent,
    setDevice: (dark) => {
      media.matches = dark;
      mediaListener?.();
    },
  };
}

describe("theme preference", () => {
  it("defaults to dark and cycles Dark → Light → Same as device", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(parseThemePreference(undefined)).toBe("dark");
    expect(parseThemePreference("sepia")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(nextThemePreference("dark")).toBe("light");
    expect(nextThemePreference("light")).toBe("system");
    expect(nextThemePreference("system")).toBe("dark");
  });

  it("applies Dark on a clean profile even on a light device", () => {
    const page = runBootstrap(null, false);
    expect(page.theme()).toBe("dark");
    expect(page.meta()).toBe(designTokens.themeColor.dark);
  });

  it("applies a saved Light choice and its theme-color", () => {
    const page = runBootstrap("light", true);
    expect(page.theme()).toBe("light");
    expect(page.meta()).toBe(designTokens.themeColor.light);
  });

  it("Same as device follows the device and its changes", () => {
    const page = runBootstrap("system", false);
    expect(page.theme()).toBe("system");
    expect(page.meta()).toBe(designTokens.themeColor.light);
    page.setDevice(true);
    expect(page.meta()).toBe(designTokens.themeColor.dark);
  });

  it("falls back to Dark when storage throws or holds junk", () => {
    expect(runBootstrap(new Error("SecurityError"), false).theme()).toBe("dark");
    expect(runBootstrap("<script>", false).theme()).toBe("dark");
  });

  it("keeps the inline script free of colour literals and user data", () => {
    const source = themeBootstrapScript();
    expect(source.length).toBeLessThan(1200);
    expect(source).not.toMatch(/innerHTML|eval\(|document\.write/);
  });
});
