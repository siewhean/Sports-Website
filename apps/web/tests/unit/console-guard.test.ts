import { describe, expect, it } from "vitest";
import {
  isExpectedFrameworkWarning,
  isExpectedPublicEventSourceCancellation,
  isExpectedPublicEventSourceTeardownConsoleError,
  isExpectedRscNavigationCancellation,
  isExpectedTeardownFontCancellation,
  isExpectedTeardownIdentityCancellation,
  isExpectedTeardownIdentityPageError,
  isExpectedTeardownMetadataIconCancellation,
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

describe("RSC navigation cancellation", () => {
  const cancellation = {
    failure: "Load request cancelled",
    method: "GET",
    pageUrl: "https://127.0.0.1:3100/organiser/competitions/cmp_sgopen_2026",
    requestUrl: "https://127.0.0.1:3100/organiser/competitions/cmp_sgopen_2026/setup?_rsc=abc123",
  };

  it("ignores only a same-origin cancelled GET RSC navigation", () => {
    expect(isExpectedRscNavigationCancellation(cancellation)).toBe(true);
    expect(isExpectedRscNavigationCancellation({ ...cancellation, failure: "cancelled" })).toBe(true);
    expect(isExpectedRscNavigationCancellation({ ...cancellation, failure: "net::ERR_ABORTED" })).toBe(true);
    expect(isExpectedRscNavigationCancellation({ ...cancellation, failure: "NS_BINDING_ABORTED" })).toBe(true);
    expect(isExpectedRscNavigationCancellation({ ...cancellation, failure: "NS_BASE_STREAM_CLOSED" })).toBe(true);
  });

  it.each([
    { ...cancellation, failure: "failed" },
    { ...cancellation, failure: "NS_BASE_STREAM_CLOSED", method: "POST" },
    { ...cancellation, method: "POST" },
    { ...cancellation, requestUrl: "https://cdn.example.com/organiser?_rsc=abc123" },
    { ...cancellation, requestUrl: "https://127.0.0.1:3100/api/competitions?_rsc=abc123" },
    { ...cancellation, requestUrl: "https://127.0.0.1:3100/organiser/competitions/cmp_sgopen_2026/setup" },
    { ...cancellation, pageUrl: "about:blank" },
  ])("keeps genuine or unrelated request failures observable", (input) => {
    expect(isExpectedRscNavigationCancellation(input)).toBe(false);
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

describe("identity teardown cancellation", () => {
  const cancellation = {
    failure: "cancelled",
    pageUrl: "https://127.0.0.1:3100/organiser",
    requestUrl: "https://127.0.0.1:3100/api/identity/current",
  };

  it("ignores only same-origin identity status cancelled during navigation teardown", () => {
    expect(isExpectedTeardownIdentityCancellation(cancellation)).toBe(true);
    expect(isExpectedTeardownIdentityCancellation({ ...cancellation, failure: "net::ERR_ABORTED" })).toBe(true);
  });

  it.each([
    { ...cancellation, failure: "net::ERR_FAILED" },
    { ...cancellation, requestUrl: "https://cdn.example.com/api/identity/current" },
    { ...cancellation, requestUrl: "https://127.0.0.1:3100/api/competitions" },
    { ...cancellation, pageUrl: "about:blank" },
  ])("keeps genuine or unrelated identity failures observable", (input) => {
    expect(isExpectedTeardownIdentityCancellation(input)).toBe(false);
  });
});

describe("identity teardown page error", () => {
  it("ignores WebKit navigation-teardown identity access control errors", () => {
    expect(
      isExpectedTeardownIdentityPageError("/127.0.0.1:3100/api/identity/current due to access control checks."),
    ).toBe(true);
    expect(
      isExpectedTeardownIdentityPageError(
        "Fetch API cannot load http://127.0.0.1:3100/api/identity/current due to access control checks.",
      ),
    ).toBe(true);
  });

  it.each([
    "/127.0.0.1:3100/api/identity/current failed to load",
    "/127.0.0.1:3100/api/competitions due to access control checks.",
    "TypeError: undefined is not an object",
  ])("keeps other page errors observable", (message) => {
    expect(isExpectedTeardownIdentityPageError(message)).toBe(false);
  });
});

describe("public EventSource teardown cancellation", () => {
  const input = {
    failure: "net::ERR_ABORTED",
    pageUrl: "http://localhost:3103/competitions/safe-public",
    requestUrl: "http://localhost:3103/api/v1/public/competitions/safe-public/versions",
    resourceType: "eventsource",
  };
  it.each(["net::ERR_ABORTED", "cancelled", "Load request cancelled", "NS_BINDING_ABORTED", "NS_BASE_STREAM_CLOSED"])(
    "accepts an exact same-origin public stream cancellation: %s",
    (failure) => {
      expect(isExpectedPublicEventSourceCancellation({ ...input, failure })).toBe(true);
    },
  );
  it.each([
    { ...input, failure: "net::ERR_CONNECTION_REFUSED" },
    { ...input, failure: "net::ERR_FAILED" },
    { ...input, failure: "404" },
    { ...input, resourceType: "fetch" },
    { ...input, requestUrl: "https://other.test/api/v1/public/competitions/safe-public/versions" },
    { ...input, requestUrl: "http://localhost:3103/api/v1/competitions/private/versions" },
    { ...input, requestUrl: "http://localhost:3103/api/v1/public/competitions/safe-public/current" },
    { ...input, requestUrl: input.requestUrl + "?unexpected=1" },
    { ...input, pageUrl: "about:blank" },
  ])("retains HTTP/connection errors and unrelated cancellation", (value) => {
    expect(isExpectedPublicEventSourceCancellation(value)).toBe(false);
  });
});

describe("Firefox public version-stream teardown console error", () => {
  const pageUrl = "http://localhost:3103/competitions/demo?tab=schedule";
  const text = (stream: string, file = "http://localhost:3103/_next/static/chunks/217847pw7shvy.js") =>
    `[JavaScript Error: "The connection to ${stream} was interrupted while the page was loading." {file: "${file}" line: 1}]`;

  it("accepts only the same-origin public versions stream torn down by navigation", () => {
    expect(
      isExpectedPublicEventSourceTeardownConsoleError({
        text: text("http://localhost:3103/api/v1/public/competitions/demo/versions"),
        pageUrl,
      }),
    ).toBe(true);
  });

  it.each([
    text("http://evil.test/api/v1/public/competitions/demo/versions"),
    text("http://localhost:3103/api/v1/public/competitions/demo/versions?x=1"),
    text("http://localhost:3103/api/v1/scoring/events"),
    text("http://localhost:3103/api/v1/public/competitions/demo/versions", "http://evil.test/_next/static/chunks/a.js"),
    `[JavaScript Error: "Firefox can’t establish a connection to the server at http://localhost:3103/api/v1/public/competitions/demo/versions." {file: "http://localhost:3103/_next/static/chunks/a.js" line: 1}]`,
    "Uncaught TypeError: boom",
  ])("retains every other console error", (value) => {
    expect(isExpectedPublicEventSourceTeardownConsoleError({ text: value, pageUrl })).toBe(false);
  });
});

describe("metadata icon teardown cancellation", () => {
  const base = { failure: "NS_BINDING_ABORTED", pageUrl: "http://localhost:3103/competitions/demo" };

  it("accepts only cancelled same-origin Next metadata icons", () => {
    for (const requestUrl of [
      "http://localhost:3103/icon.svg?icon.3044exl5869oe.svg",
      "http://localhost:3103/apple-icon.png?apple-icon.3tjocgii875t5.png",
    ])
      expect(isExpectedTeardownMetadataIconCancellation({ ...base, requestUrl })).toBe(true);
  });

  it.each([
    { ...base, requestUrl: "http://evil.test/icon.svg?icon.abc.svg" },
    { ...base, requestUrl: "http://localhost:3103/icon.svg" },
    { ...base, requestUrl: "http://localhost:3103/icon.svg?icon.abc.svg&x=1" },
    { ...base, requestUrl: "http://localhost:3103/logo.png?icon.abc.png" },
    { ...base, failure: "NS_ERROR_CONNECTION_REFUSED", requestUrl: "http://localhost:3103/icon.svg?icon.abc.svg" },
  ])("retains every other failure", (input) => {
    expect(isExpectedTeardownMetadataIconCancellation(input)).toBe(false);
  });
});
