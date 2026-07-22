import { describe, expect, it } from "vitest";
import { assertSafeDeploymentDataMode } from "./deployment-data-mode.server";

function environment(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values };
}

describe("deployment data-mode guard", () => {
  it("allows explicitly isolated local and test demo fixtures", () => {
    expect(() =>
      assertSafeDeploymentDataMode(environment({ APP_ENV: "local", MATCHDAY_PHASE2_DATA_MODE: "demo" })),
    ).not.toThrow();
    expect(() =>
      assertSafeDeploymentDataMode(environment({ APP_ENV: "test", MATCHDAY_PHASE2_DATA_MODE: "demo" })),
    ).not.toThrow();
  });

  it("rejects demo data in staging and production at request time", () => {
    for (const appEnvironment of ["staging", "production"]) {
      expect(() =>
        assertSafeDeploymentDataMode(
          environment({
            APP_ENV: appEnvironment,
            MATCHDAY_PHASE2_DATA_MODE: "demo",
            MATCHDAY_API_BASE_URL: "https://api.matchday.example",
          }),
        ),
      ).toThrow(/demo is forbidden/i);
    }
  });

  it("requires one credential-free HTTPS API origin in deployed environments", () => {
    expect(() =>
      assertSafeDeploymentDataMode(environment({ APP_ENV: "production", MATCHDAY_PHASE2_DATA_MODE: "api" })),
    ).toThrow(/must be configured/i);

    for (const invalid of [
      "http://api.matchday.example",
      "https://user:password@api.matchday.example",
      "https://api.matchday.example/v1",
      "https://api.matchday.example?region=sg",
      "https://api.matchday.example#fragment",
    ]) {
      expect(() =>
        assertSafeDeploymentDataMode(
          environment({ APP_ENV: "production", MATCHDAY_PHASE2_DATA_MODE: "api", MATCHDAY_API_BASE_URL: invalid }),
        ),
      ).toThrow();
    }

    expect(() =>
      assertSafeDeploymentDataMode(
        environment({
          APP_ENV: "production",
          MATCHDAY_PHASE2_DATA_MODE: "api",
          MATCHDAY_API_BASE_URL: "https://api.matchday.example",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects unknown environment and data-mode values", () => {
    expect(() =>
      assertSafeDeploymentDataMode(environment({ APP_ENV: "preview", MATCHDAY_PHASE2_DATA_MODE: "api" })),
    ).toThrow(/APP_ENV/i);
    expect(() =>
      assertSafeDeploymentDataMode(environment({ APP_ENV: "local", MATCHDAY_PHASE2_DATA_MODE: "sample" })),
    ).toThrow(/MATCHDAY_PHASE2_DATA_MODE/i);
  });
});
