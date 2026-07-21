import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("distributed rate limiting", () => {
  it("shares authenticated-account limits across API instances and separates accounts", async () => {
    const config = testConfig();
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const options = {
      config,
      probes: healthyProbes,
      authenticatedRateLimitMax: 2,
      anonymousRateLimitMax: 1,
      resolveRateLimitAccountId: (request: FastifyRequest) => {
        const value = request.headers["x-test-account-id"];
        return typeof value === "string" ? value : null;
      },
    };
    const first = await buildApp({
      ...options,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    const second = await buildApp({
      ...options,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    apps.push(first, second);

    const accountHeaders = { "x-test-account-id": "account-a" };
    expect((await first.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders })).statusCode).toBe(
      200,
    );
    expect((await second.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders })).statusCode).toBe(
      200,
    );
    const limited = await first.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");

    expect(
      (
        await second.inject({
          method: "GET",
          url: "/api/v1/status",
          headers: { "x-test-account-id": "account-b" },
        })
      ).statusCode,
    ).toBe(200);
  });
});
