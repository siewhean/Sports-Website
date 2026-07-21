import { describe, expect, it } from "vitest";
import {
  isExpectedTeardownFontCancellation,
  isExpectedTeardownServiceWorkerCancellation,
} from "../helpers/console-guard";

const localFont = {
  failure: "cancelled",
  pageUrl: "https://127.0.0.1:3100/internal/sport-defaults",
  requestUrl: "https://127.0.0.1:3100/_next/static/media/Geist_Variable.woff2",
  resourceType: "font",
};

describe("browser console guard", () => {
  it("ignores only an exactly cancelled same-origin webfont", () => {
    expect(isExpectedTeardownFontCancellation(localFont)).toBe(true);
  });

  it.each([
    { ...localFont, failure: "net::ERR_FAILED" },
    { ...localFont, resourceType: "script" },
    { ...localFont, requestUrl: "https://cdn.example.com/Geist_Variable.woff2" },
    { ...localFont, requestUrl: "https://127.0.0.1:3100/api/font" },
    { ...localFont, pageUrl: "about:blank" },
  ])("keeps genuine or unrelated request failures observable", (input) => {
    expect(isExpectedTeardownFontCancellation(input)).toBe(false);
  });
});

describe("service-worker teardown cancellation", () => {
  const cancellation = {
    failure: "cancelled",
    pageUrl: "https://127.0.0.1:3100/internal/sport-defaults",
    requestUrl: "https://127.0.0.1:3100/sw.js",
  };

  it("ignores only the exact same-origin cancelled service-worker request", () => {
    expect(isExpectedTeardownServiceWorkerCancellation(cancellation)).toBe(true);
  });

  it.each([
    { ...cancellation, failure: "net::ERR_FAILED" },
    { ...cancellation, requestUrl: "https://cdn.example.com/sw.js" },
    { ...cancellation, requestUrl: "https://127.0.0.1:3100/sw-other.js" },
    { ...cancellation, pageUrl: "about:blank" },
  ])("keeps real or unrelated service-worker failures observable", (input) => {
    expect(isExpectedTeardownServiceWorkerCancellation(input)).toBe(false);
  });
});
