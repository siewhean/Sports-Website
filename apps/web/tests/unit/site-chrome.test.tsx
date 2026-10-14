import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { SiteFooter } from "../../components/foundation/SiteChrome";

describe("SiteFooter Status Page link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("links to internal maintenance page when NEXT_PUBLIC_STATUS_PAGE_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_STATUS_PAGE_URL;
    const html = renderToString(<SiteFooter />);
    expect(html).toContain('href="/maintenance"');
    expect(html).toContain("Status");
    expect(html).not.toContain('target="_blank"');
  });

  it("links to external status page with security attributes when NEXT_PUBLIC_STATUS_PAGE_URL is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_STATUS_PAGE_URL", "https://matchday-poladex.betteruptime.com");
    const html = renderToString(<SiteFooter />);
    expect(html).toContain('href="https://matchday-poladex.betteruptime.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Status");
    expect(html).toContain("(opens in a new tab)");
  });

  it.each(["http://matchday-poladex.betteruptime.com", "javascript:alert(1)", "//evil.example"])(
    "falls back to the maintenance page for non-https value %s",
    (value) => {
      vi.stubEnv("NEXT_PUBLIC_STATUS_PAGE_URL", value);
      const html = renderToString(<SiteFooter />);
      expect(html).toContain('href="/maintenance"');
      expect(html).not.toContain('target="_blank"');
    },
  );
});
