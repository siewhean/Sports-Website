import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSentryDsn } from "@/lib/sentry-config";
import { scrubSentryEvent } from "@/lib/sentry-scrub";
import { POST } from "@/lib/sentry-tunnel";

const dsn = "https://publickey@o1.ingest.sentry.io/4500";

function envelope(headerDsn: string | undefined) {
  const header = JSON.stringify(headerDsn ? { dsn: headerDsn } : {});
  return new Request("https://matchday.test/api/monitoring", {
    method: "POST",
    body: `${header}\n{"type":"event"}\n{}`,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sentry configuration", () => {
  it("treats blank or malformed DSNs as disabled", () => {
    expect(parseSentryDsn(undefined)).toBeUndefined();
    expect(parseSentryDsn("  ")).toBeUndefined();
    expect(parseSentryDsn("nonsense")).toBeUndefined();
    expect(parseSentryDsn("https://o1.ingest.sentry.io/4500")).toBeUndefined();
    expect(parseSentryDsn(dsn)).toMatchObject({ host: "o1.ingest.sentry.io", projectId: "4500" });
  });

  it("scrubs request PII from events", () => {
    const event = scrubSentryEvent({
      message: "x jane@example.com",
      request: { url: "https://a.test/p?x=1", cookies: { a: "b" }, headers: { Cookie: "a=b", Accept: "*/*" } },
    }) as { message: string; request: { url: string; cookies?: unknown; headers: Record<string, string> } };
    expect(event.message).toBe("x [email]");
    expect(event.request.url).toBe("https://a.test/p");
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.headers).toEqual({ Cookie: "[Filtered]", Accept: "*/*" });
  });
});

describe("sentry tunnel route", () => {
  it("is a 404 and never calls out when no DSN is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await POST(envelope(dsn))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects envelopes for any other project or host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await POST(envelope("https://publickey@o1.ingest.sentry.io/9999"))).status).toBe(403);
    expect((await POST(envelope("https://publickey@evil.example/4500"))).status).toBe(403);
    expect((await POST(envelope(undefined))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a matching envelope to the configured project only", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await POST(envelope(dsn))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://o1.ingest.sentry.io/api/4500/envelope/");
  });
});
