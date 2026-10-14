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
    vi.stubEnv("NEXT_PUBLIC_STATUS_PAGE_URL", "https://status.matchday.sport");
    const html = renderToString(<SiteFooter />);
    expect(html).toContain('href="https://status.matchday.sport"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Status");
  });
});
