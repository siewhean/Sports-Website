import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../../proxy";

describe("web transport security headers", () => {
  it("keeps an explicit local HTTP origin usable without weakening HTTPS responses", () => {
    const response = proxy(new NextRequest("http://localhost:3103/organiser"));

    expect(response.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("uses the trusted forwarded scheme for an HTTPS-terminating proxy", () => {
    const request = new NextRequest("http://web.internal/organiser", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    const response = proxy(request);

    expect(response.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains; preload");
  });

  it("uses the request URL scheme when no forwarded scheme exists", () => {
    const response = proxy(new NextRequest("https://matchday.test/organiser"));

    expect(response.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains; preload");
  });
});
