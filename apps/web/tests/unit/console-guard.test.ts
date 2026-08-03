import { describe, expect, it } from "vitest";
import {
  isExpectedFrameworkWarning,
  isExpectedTeardownFontCancellation,
  isExpectedTeardownServiceWorkerCancellation,
  isExpectedTeardownStaticAssetCancellation,
} from "../helpers/console-guard";

describe("framework warning filtering", () => {
  it("ignores only Firefox's Playwright debugger-layout warning", () => {
    expect(
      isExpectedFrameworkWarning(
        '[JavaScript Warning: "Layout was forced before the page was fully loaded. If stylesheets are not yet loaded this may cause a flash of unstyled content." {file: "debugger eval code" line: 393}]',
      ),
    ).toBe(true);
  });

  it("ignores Firefox's equivalent Next Geist font-preload wording", () => {
    expect(
      isExpectedFrameworkWarning(
        '[JavaScript Warning: "The resource at “http://localhost:3103/_next/static/media/Geist_Variable.woff2” preloaded with link preload was not used within a few seconds. Make sure all attributes of the preload tag are set correctly." {file: "http://localhost:3103/organiser" line: 0}]',
      ),
    ).toBe(true);
  });

  it.each([
    "Layout was forced before the page was fully loaded.",
    '[JavaScript Warning: "Layout was forced before the page was fully loaded. If stylesheets are not yet loaded this may cause a flash of unstyled content." {file: "app.js" line: 393}]',
    '[JavaScript Warning: "A different warning" {file: "debugger eval code" line: 393}]',
  ])("keeps unrelated framework warnings observable", (warning) => {
    expect(isExpectedFrameworkWarning(warning)).toBe(false);
  });
});

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

describe("static-asset teardown cancellation", () => {
  const cancellation = {
    failure: "cancelled",
    pageUrl: "https://127.0.0.1:3100/organiser",
    requestUrl: "https://127.0.0.1:3100/_next/static/chunks/app.js",
    resourceType: "script",
  };

  it("ignores only same-origin Next scripts or styles cancelled during navigation teardown", () => {
    expect(isExpectedTeardownStaticAssetCancellation(cancellation)).toBe(true);
    expect(isExpectedTeardownStaticAssetCancellation({ ...cancellation, resourceType: "stylesheet" })).toBe(true);
    expect(isExpectedTeardownStaticAssetCancellation({ ...cancellation, failure: "net::ERR_ABORTED" })).toBe(true);
  });

  it.each([
    { ...cancellation, failure: "net::ERR_FAILED" },
    { ...cancellation, requestUrl: "https://cdn.example.com/_next/static/chunks/app.js" },
    { ...cancellation, requestUrl: "https://127.0.0.1:3100/api/competitions" },
    { ...cancellation, resourceType: "fetch" },
    { ...cancellation, pageUrl: "about:blank" },
  ])("keeps genuine or unrelated asset failures observable", (input) => {
    expect(isExpectedTeardownStaticAssetCancellation(input)).toBe(false);
  });
});
