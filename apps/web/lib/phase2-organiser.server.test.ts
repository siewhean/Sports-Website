import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestState = vi.hoisted(() => ({ cookie: "session-token", host: "c5-staging.poladex.shop" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: requestState.host, "x-forwarded-host": requestState.host }),
  cookies: async () => ({
    get: (name: string) =>
      name === "matchday_session" && requestState.cookie ? { value: requestState.cookie } : undefined,
  }),
}));

import { getOrganiserCompetitionView } from "./phase2-organiser.server";
import { getOrganiserCompetitions } from "./organiser-competitions.server";

const originalApiBase = process.env.MATCHDAY_API_BASE_URL;
const originalAppEnv = process.env.APP_ENV;
const originalDataMode = process.env.MATCHDAY_PHASE2_DATA_MODE;
const competitionId = "00000000-0000-4000-8000-000000000010";

describe("organiser server authentication boundary", () => {
  beforeEach(() => {
    requestState.cookie = "session-token";
    requestState.host = "c5-staging.poladex.shop";
    process.env.MATCHDAY_API_BASE_URL = "https://c5-staging.poladex.shop";
    process.env.APP_ENV = "staging";
    delete process.env.MATCHDAY_PHASE2_DATA_MODE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiBase === undefined) delete process.env.MATCHDAY_API_BASE_URL;
    else process.env.MATCHDAY_API_BASE_URL = originalApiBase;
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalDataMode === undefined) delete process.env.MATCHDAY_PHASE2_DATA_MODE;
    else process.env.MATCHDAY_PHASE2_DATA_MODE = originalDataMode;
  });

  it("distinguishes an expired or missing session from an authenticated denial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(getOrganiserCompetitionView(competitionId)).resolves.toEqual({ state: "unauthenticated" });
    await expect(getOrganiserCompetitions()).resolves.toEqual({ state: "unauthenticated" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(getOrganiserCompetitionView(competitionId)).resolves.toEqual({ state: "permission" });
    await expect(getOrganiserCompetitions()).resolves.toEqual({ state: "permission" });
  });
});
