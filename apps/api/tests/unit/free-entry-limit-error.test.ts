import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

/** Shape of the postgres.js error raised by the phase3_enforce_free_entry_limit trigger. */
function freeEntryTriggerError() {
  return Object.assign(new Error("free plan permits at most 16 active entries per competition"), {
    name: "PostgresError",
    code: "P0001",
  });
}

describe("free-plan entry cap error mapping", () => {
  it("returns 422 FREE_ENTRY_LIMIT_REACHED instead of a 500 when the trigger rejects an entry", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: {
        ...healthyProbes,
        database: async () => {
          throw freeEntryTriggerError();
        },
      },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health/deep" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "FREE_ENTRY_LIMIT_REACHED" });
    expect(response.json().error.message).toMatch(/free plan/i);
  });

  it("keeps other raised database exceptions as 500", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: {
        ...healthyProbes,
        database: async () => {
          throw Object.assign(new Error("something else"), { code: "P0001" });
        },
      },
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/deep" })).statusCode).toBe(500);
  });
});
