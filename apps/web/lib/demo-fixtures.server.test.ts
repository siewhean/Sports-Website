import { describe, expect, it } from "vitest";
import { demoFixturesEnabled } from "./demo-fixtures.server";

describe("demo fixture deployment guard", () => {
  it("requires an explicit acknowledgement in addition to demo data mode", () => {
    expect(() => demoFixturesEnabled({ APP_ENV: "local", MATCHDAY_PHASE2_DATA_MODE: "demo" })).toThrow(
      "MATCHDAY_ALLOW_DEMO_FIXTURES=1",
    );
  });

  it.each(["staging", "production"])("rejects demo fixtures in %s builds", (environment) => {
    expect(() =>
      demoFixturesEnabled({
        APP_ENV: environment,
        MATCHDAY_PHASE2_DATA_MODE: "demo",
        MATCHDAY_ALLOW_DEMO_FIXTURES: "1",
      }),
    ).toThrow("restricted to local and test environments");
  });

  it.each(["local", "test"])("allows explicitly acknowledged %s fixtures", (environment) => {
    expect(
      demoFixturesEnabled({
        APP_ENV: environment,
        MATCHDAY_PHASE2_DATA_MODE: "demo",
        MATCHDAY_ALLOW_DEMO_FIXTURES: "1",
      }),
    ).toBe(true);
  });

  it("keeps fixtures disabled when demo mode was not requested", () => {
    expect(
      demoFixturesEnabled({
        APP_ENV: "production",
        MATCHDAY_PHASE2_DATA_MODE: "api",
        MATCHDAY_ALLOW_DEMO_FIXTURES: "1",
      }),
    ).toBe(false);
  });
});
