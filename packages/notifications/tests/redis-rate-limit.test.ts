import { describe, expect, it } from "vitest";
import { NotificationRateLimitError, RedisNotificationRateLimiter, type RedisEvalClient } from "../src/index.js";

describe("RedisNotificationRateLimiter", () => {
  it("fails closed when the shared Redis script reports a full window", async () => {
    const client: RedisEvalClient = {
      async eval() {
        return [0, 750];
      },
    };
    const limiter = new RedisNotificationRateLimiter(client, {
      maximum: 1,
      windowMs: 1_000,
    });

    await expect(limiter.assertAllowed("account-1", "result-corrected", new Date(1_000))).rejects.toEqual(
      new NotificationRateLimitError(750),
    );
  });

  it("rejects malformed Redis responses instead of allowing a notification", async () => {
    const client: RedisEvalClient = {
      async eval() {
        return "unexpected";
      },
    };
    const limiter = new RedisNotificationRateLimiter(client, {
      maximum: 1,
      windowMs: 1_000,
    });

    await expect(limiter.assertAllowed("account-1", "result-corrected", new Date(1_000))).rejects.toThrow(
      "invalid response",
    );
  });

  it("generates a distinct Redis sorted-set member for every attempt", async () => {
    const members: string[] = [];
    const client: RedisEvalClient = {
      async eval(_script, options) {
        members.push(options.arguments[3] ?? "");
        return [1, 0];
      },
    };
    const limiter = new RedisNotificationRateLimiter(client, { maximum: 2, windowMs: 1_000 });
    await limiter.assertAllowed("account-1", "result-corrected", new Date(1_000));
    await limiter.assertAllowed("account-1", "result-corrected", new Date(1_000));
    expect(new Set(members).size).toBe(2);
  });
});
