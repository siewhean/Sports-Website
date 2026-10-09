import { describe, expect, it } from "vitest";

import { initSentryNode } from "./sentry.js";
import { scrubSentryEvent, scrubSentryString } from "./sentry-scrub.js";

describe("sentry gating", () => {
  it("is fully off without a valid DSN", () => {
    expect(initSentryNode({ service: "t", env: {} })).toBeUndefined();
    expect(initSentryNode({ service: "t", env: { SENTRY_DSN: "   " } })).toBeUndefined();
    expect(initSentryNode({ service: "t", env: { SENTRY_DSN: "not a dsn" } })).toBeUndefined();
  });
});

describe("sentry scrubbing", () => {
  it("strips query strings, opaque path tokens and emails from strings", () => {
    expect(scrubSentryString("https://x.test/a/b?token=abc#frag")).toBe("https://x.test/a/b");
    expect(scrubSentryString("failed for jane.doe@example.com at https://x.test/a?e=1")).toBe(
      "failed for [email] at https://x.test/a",
    );
    expect(scrubSentryString(`/score/${"a".repeat(40)}`)).toBe("/score/:redacted");
  });

  it("removes cookies, sensitive headers, query, body and user", () => {
    const scrubbed = scrubSentryEvent({
      user: { email: "a@b.co", ip_address: "1.2.3.4" },
      message: "boom a@b.co",
      request: {
        url: "https://x.test/p?q=1",
        query_string: "q=1",
        cookies: { sid: "1" },
        data: { name: "x" },
        headers: {
          Cookie: "a=b",
          Authorization: "Bearer z",
          "X-CSRF-Token": "c",
          "x-scoring-session-token": "s",
          "user-agent": "ua",
        },
      },
    }) as {
      user?: unknown;
      message: string;
      request: {
        url: string;
        query_string?: unknown;
        cookies?: unknown;
        data?: unknown;
        headers: Record<string, string>;
      };
    };
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.message).toBe("boom [email]");
    expect(scrubbed.request.url).toBe("https://x.test/p");
    expect(scrubbed.request.query_string).toBeUndefined();
    expect(scrubbed.request.cookies).toBeUndefined();
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.request.headers.Cookie).toBe("[Filtered]");
    expect(scrubbed.request.headers.Authorization).toBe("[Filtered]");
    expect(scrubbed.request.headers["X-CSRF-Token"]).toBe("[Filtered]");
    expect(scrubbed.request.headers["x-scoring-session-token"]).toBe("[Filtered]");
    expect(scrubbed.request.headers["user-agent"]).toBe("ua");
  });
});
