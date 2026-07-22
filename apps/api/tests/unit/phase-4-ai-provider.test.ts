import { describe, expect, it } from "vitest";
import { DeterministicPhase4AiStub, phase4AiProviderFromEnvironment } from "../../src/phase-4-ai-provider.js";

describe("Phase 4 AI provider boundary", () => {
  it("defaults every environment to the disabled manual path", () => {
    for (const environment of ["local", "test", "staging", "production"]) {
      expect(phase4AiProviderFromEnvironment(environment, {})).toMatchObject({ mode: "disabled", provider: null });
    }
  });

  it("permits the deterministic stub only in local and test", () => {
    for (const environment of ["local", "test"]) {
      const configured = phase4AiProviderFromEnvironment(environment, { PHASE4_AI_PROVIDER: "stub" });
      expect(configured.mode).toBe("stub");
      expect(configured.provider).toBeInstanceOf(DeterministicPhase4AiStub);
    }
    for (const environment of ["staging", "production"]) {
      expect(() => phase4AiProviderFromEnvironment(environment, { PHASE4_AI_PROVIDER: "stub" })).toThrow(
        /local\/test/i,
      );
    }
  });

  it("rejects unknown providers and unsafe retry configuration", () => {
    expect(() => phase4AiProviderFromEnvironment("production", { PHASE4_AI_PROVIDER: "live" })).toThrow(
      /disabled or stub/i,
    );
    expect(() =>
      phase4AiProviderFromEnvironment("local", {
        PHASE4_AI_PROVIDER: "disabled",
        PHASE4_AI_MAX_ATTEMPTS: "4",
      }),
    ).toThrow(/1 to 3/i);
  });

  it("keeps bounded production-safe operational defaults while disabled", () => {
    expect(phase4AiProviderFromEnvironment("production", { PHASE4_AI_PROVIDER: "disabled" })).toEqual({
      mode: "disabled",
      provider: null,
      timeoutMs: 8_000,
      maximumAttempts: 3,
      cacheTtlSeconds: 86_400,
    });
  });
});
