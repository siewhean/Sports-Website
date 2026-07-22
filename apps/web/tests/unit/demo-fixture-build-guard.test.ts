import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const guard = path.resolve(process.cwd(), "scripts/assert-demo-fixture-env.mjs");

function runGuard(environment: Record<string, string | undefined>) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [guard], { env, encoding: "utf8" });
}

describe("demo fixture build guard", () => {
  it("rejects an unacknowledged demo build", () => {
    const result = runGuard({
      APP_ENV: "local",
      MATCHDAY_PHASE2_DATA_MODE: "demo",
      MATCHDAY_ALLOW_DEMO_FIXTURES: undefined,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MATCHDAY_ALLOW_DEMO_FIXTURES=1");
  });

  it("rejects acknowledged demo fixtures in production", () => {
    const result = runGuard({
      APP_ENV: "production",
      MATCHDAY_PHASE2_DATA_MODE: "demo",
      MATCHDAY_ALLOW_DEMO_FIXTURES: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restricted to local and test environments");
  });

  it("allows explicitly acknowledged local demo builds", () => {
    const result = runGuard({
      APP_ENV: "local",
      MATCHDAY_PHASE2_DATA_MODE: "demo",
      MATCHDAY_ALLOW_DEMO_FIXTURES: "1",
    });
    expect(result.status).toBe(0);
  });
});
