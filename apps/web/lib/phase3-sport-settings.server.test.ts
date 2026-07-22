import { afterEach, describe, expect, it } from "vitest";
import { getSportDefaultsAdminDocument } from "./phase3-sport-settings.server";

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  MATCHDAY_PHASE2_DATA_MODE: process.env.MATCHDAY_PHASE2_DATA_MODE,
  MATCHDAY_ALLOW_DEMO_FIXTURES: process.env.MATCHDAY_ALLOW_DEMO_FIXTURES,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sport defaults server boundary", () => {
  it("fails closed for an unsupported sport instead of loading Canoe Polo", async () => {
    process.env.APP_ENV = "local";
    process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
    process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";

    await expect(getSportDefaultsAdminDocument("football")).resolves.toMatchObject({
      state: "error",
      canManage: false,
      activeSportId: null,
      versions: [],
    });
  });

  it("requires an explicit sport instead of defaulting to Canoe Polo", async () => {
    await expect(getSportDefaultsAdminDocument()).resolves.toMatchObject({
      state: "error",
      canManage: false,
      activeSportId: null,
      versions: [],
    });
  });
});
