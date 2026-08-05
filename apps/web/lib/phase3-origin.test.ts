import { describe, expect, it } from "vitest";
import {
  configuredPublicOrigin,
  requestCanForwardSessionCookie,
  requestForwardedOrigin,
  requestOriginMatchesHost,
  requestPublicOrigin,
} from "./phase3-origin";

describe("Phase 3 same-origin boundary", () => {
  it("accepts the actual request host even when framework URL canonicalisation differs", () => {
    expect(requestOriginMatchesHost("http://127.0.0.1:3111", "127.0.0.1:3111", "http")).toBe(true);
    expect(requestOriginMatchesHost("https://matchday.example", "matchday.example", "https")).toBe(true);
  });

  it("rejects cross-host, protocol, credential and malformed origins", () => {
    expect(requestOriginMatchesHost("http://localhost:3111", "127.0.0.1:3111", "http")).toBe(false);
    expect(requestOriginMatchesHost("http://matchday.example", "matchday.example", "https")).toBe(false);
    expect(requestOriginMatchesHost("https://user@matchday.example", "matchday.example", "https")).toBe(false);
    expect(requestOriginMatchesHost("not-an-origin", "matchday.example", "https")).toBe(false);
  });
});

describe("Phase 3 forwarded origin", () => {
  it("uses the first forwarding values for an absolute same-origin return target", () => {
    expect(
      requestForwardedOrigin(
        new Headers({
          "x-forwarded-host": "c5-staging.poladex.shop, internal.example",
          "x-forwarded-proto": "https, http",
        }),
      ),
    ).toBe("https://c5-staging.poladex.shop");
  });

  it("rejects malformed hosts", () => {
    expect(requestForwardedOrigin(new Headers({ host: "bad/path" }))).toBeNull();
  });

  it("prefers a validated deployment public origin over an internal proxy host", () => {
    const requestHeaders = new Headers({ host: "matchdayweb-c3-staging.up.railway.app" });
    expect(requestPublicOrigin(requestHeaders, "https://c5-staging.poladex.shop")).toBe(
      "https://c5-staging.poladex.shop",
    );
    expect(configuredPublicOrigin("https://c5-staging.poladex.shop/organiser")).toBeNull();
  });

  it("forwards a session only to the configured public API host when a proxy replaces the host", () => {
    const headers = new Headers({ host: "matchdayweb-c3-staging.up.railway.app" });
    expect(requestCanForwardSessionCookie(headers, "c5-staging.poladex.shop", "https://c5-staging.poladex.shop")).toBe(
      true,
    );
    expect(requestCanForwardSessionCookie(headers, "api.attacker.test", "https://c5-staging.poladex.shop")).toBe(false);
  });
});
