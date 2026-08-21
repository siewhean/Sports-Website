import { describe, expect, it } from "vitest";
import { configuredPublicOrigin, requestOriginAllowed, requestPublicOrigin } from "./phase3-origin";

describe("Phase 3 deployed origin fail-closed behavior", () => {
  it("requires an explicit configured public origin for non-loopback mutation traffic", () => {
    const headers = new Headers({
      host: "matchday-web.internal.example",
      "x-forwarded-host": "matchday-web.internal.example",
      "x-forwarded-proto": "https",
    });

    expect(requestOriginAllowed("https://matchday-web.internal.example", headers, undefined, "https:")).toBe(false);
    expect(requestPublicOrigin(headers, undefined)).toBeNull();
  });

  it("keeps the unconfigured fallback only for local loopback development", () => {
    const headers = new Headers({ host: "127.0.0.1:3000", "x-forwarded-proto": "http" });

    expect(requestOriginAllowed("http://127.0.0.1:3000", headers, undefined, "http:")).toBe(true);
    expect(requestPublicOrigin(headers, undefined)).toBe("http://127.0.0.1:3000");
  });

  it("rejects insecure non-loopback configured origins", () => {
    expect(configuredPublicOrigin("http://matchday.example")).toBeNull();
    expect(configuredPublicOrigin("https://matchday.example")).toBe("https://matchday.example");
  });
});
