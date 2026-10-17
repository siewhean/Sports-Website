import { afterEach, describe, expect, it, vi } from "vitest";

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "matchday-redesign-shell" && cookieValue.current !== undefined
        ? { value: cookieValue.current }
        : undefined,
  }),
}));

const { isOrganiserRedesignShellEnabled } = await import("../../lib/feature-flags.server");
const { organiserRedesignShellEnabled } = await import("../../lib/organiser-shell.server");

const keys = [
  "MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL",
  "MATCHDAY_PHASE2_DATA_MODE",
  "MATCHDAY_ALLOW_DEMO_FIXTURES",
  "APP_ENV",
] as const;
const initial = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (initial[key] === undefined) delete process.env[key];
    else process.env[key] = initial[key];
  }
  cookieValue.current = undefined;
});

function useDemoFixtures() {
  process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
  process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";
  process.env.APP_ENV = "test";
}

describe("organiser redesign shell flag", () => {
  it("is off by default", async () => {
    delete process.env.MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL;
    await expect(isOrganiserRedesignShellEnabled()).resolves.toBe(false);
  });

  it("accepts typed boolean environment overrides and ignores invalid ones", async () => {
    process.env.MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL = "true";
    await expect(isOrganiserRedesignShellEnabled()).resolves.toBe(true);
    process.env.MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL = "yes";
    await expect(isOrganiserRedesignShellEnabled()).resolves.toBe(false);
  });

  it("ignores the preview cookie outside demo fixture builds", async () => {
    delete process.env.MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL;
    process.env.MATCHDAY_PHASE2_DATA_MODE = "api";
    cookieValue.current = "1";
    await expect(organiserRedesignShellEnabled()).resolves.toBe(false);
  });

  it("lets demo fixture builds preview the shell with a cookie", async () => {
    delete process.env.MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL;
    useDemoFixtures();
    await expect(organiserRedesignShellEnabled()).resolves.toBe(false);
    cookieValue.current = "1";
    await expect(organiserRedesignShellEnabled()).resolves.toBe(true);
  });
});
