import { describe, expect, it } from "vitest";
import { designTokens, shellKinds, stateTokens, surfaceStates } from "../src/tokens.js";

describe("design system tokens and states", () => {
  it("defines standard surface states with appropriate ARIA roles and visual tones", () => {
    expect(surfaceStates).toHaveLength(8);
    for (const state of surfaceStates) {
      const token = stateTokens[state];
      expect(token).toBeDefined();
      expect(["status", "alert"]).toContain(token.role);
      expect(["neutral", "warning", "danger"]).toContain(token.tone);

      // Critical error/alert states must announce immediately
      if (state === "error" || state === "conflict" || state === "permission") {
        expect(token.role).toBe("alert");
        expect(token.alert).toBe(true);
      } else {
        expect(token.role).toBe("status");
        expect(token.alert).toBe(false);
      }
    }
  });

  it("enforces mobile-first responsive breakpoints", () => {
    expect(designTokens.breakpoints.phone).toBe(375);
    expect(designTokens.breakpoints.tablet).toBe(768);
    expect(designTokens.breakpoints.desktop).toBe(1280);
    expect(designTokens.breakpoints.phone).toBeLessThan(designTokens.breakpoints.tablet);
    expect(designTokens.breakpoints.tablet).toBeLessThan(designTokens.breakpoints.desktop);
  });

  it("enforces touch target accessibility standards", () => {
    expect(designTokens.layout.minimumTouchTarget).toBeGreaterThanOrEqual(48);
    expect(designTokens.component.touchTargetMin).toBeGreaterThanOrEqual(48);
  });

  it("provides complete colour tokens for light and dark themes", () => {
    const requiredColors = ["canvas", "surface", "surfaceSubtle", "ink", "muted", "hairline", "signal", "focus"];
    for (const key of requiredColors) {
      expect(designTokens.color).toHaveProperty(key);
      expect(designTokens.darkColor).toHaveProperty(key);
    }
  });

  it("defines supported shell kinds", () => {
    expect(shellKinds).toEqual(["organiser", "official", "public"]);
  });
});
