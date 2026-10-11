import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { messages } from "@matchday/ui";
import TermsPage from "../../app/terms/page.js";
import PrivacyPage from "../../app/privacy/page.js";
import CookiesPage from "../../app/cookies/page.js";
import SupportPage from "../../app/support/page.js";
import PricingPage from "../../app/pricing/page.js";
import ScorekeeperOnboardingPage from "../../app/onboarding/scorekeeper/page.js";
import robots from "../../app/robots.js";
import sitemap from "../../app/sitemap.js";
import manifest from "../../app/manifest.js";
import { publicCompetitionJsonLd, publicMatchJsonLd, serializeJsonLd } from "../../lib/public-competition-json-ld.js";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
  }),
  // No request scope in unit tests: the SEO origin must come from configuration or be absent.
  headers: async () => {
    throw new Error("headers() called outside a request scope");
  },
}));

vi.mock("@/lib/phase2-public.server", () => ({
  getCompetitionListing: async () => [{ slug: "summer-cup" }, { slug: "broken-cup" }],
  getCompetitionView: async (slug: string) => {
    if (slug !== "summer-cup") throw new Error("upstream unavailable");
    return {
      slug: "summer-cup",
      status: "live",
      lastUpdatedAt: "2026-09-19T08:30:00.000Z",
      matches: [],
      publicDivisions: [{ matches: [{ id: "match-1", status: "final", updatedAt: "2026-09-19T08:00:00.000Z" }] }],
    };
  },
}));

describe("RES-021 & RES-025 - RES-032 Public Pages and SEO Verification", () => {
  const publicOrigin = "https://preview.matchday.test";

  it("renders terms of service page", async () => {
    const html = renderToString(await TermsPage());
    expect(html).toContain(messages.legal.termsTitle);
  });

  it("renders privacy policy page", async () => {
    const html = renderToString(await PrivacyPage());
    expect(html).toContain(messages.legal.privacyTitle);
  });

  it("renders cookie policy page", async () => {
    const html = renderToString(await CookiesPage());
    expect(html).toContain(messages.legal.cookiesTitle);
  });

  it("renders support and FAQ page", () => {
    const html = renderToString(React.createElement(SupportPage));
    expect(html).toContain(messages.support.title.replace("&", "&amp;"));
    expect(html).toContain(messages.support.faqTitle);
    expect(html).toContain(messages.support.contactEmail);
  });

  it("renders pricing page with commercial tiers", async () => {
    const html = renderToString(await PricingPage());
    expect(html).toContain(messages.pricing.title);
    expect(html).toContain(messages.pricing.starterName);
    expect(html).toContain(messages.pricing.eventPassName);
    expect(html).toContain(messages.pricing.proName);
  });

  it("renders scorekeeper onboarding page", () => {
    const html = renderToString(React.createElement(ScorekeeperOnboardingPage));
    expect(html).toContain(messages.onboarding.title.replace("&", "&amp;"));
    expect(html).toContain(messages.onboarding.step1Title);
    expect(html).toContain(messages.onboarding.step2Title);
  });

  it("generates robots.txt rules with a Sitemap line and private surfaces disallowed", async () => {
    process.env.MATCHDAY_PUBLIC_ORIGIN = publicOrigin;
    const robotRules = await robots();
    const rules = Array.isArray(robotRules.rules) ? robotRules.rules[0] : robotRules.rules;
    expect(rules?.allow).toBe("/");
    expect(rules?.disallow).toEqual(
      expect.arrayContaining(["/api/", "/organiser", "/score", "/official", "/internal", "/notifications", "/sign-in"]),
    );
    expect(robotRules.sitemap).toBe(`${publicOrigin}/sitemap.xml`);
  });

  it("lists static pages, public competitions and their matches in the sitemap", async () => {
    process.env.MATCHDAY_PUBLIC_ORIGIN = publicOrigin;
    const siteMapEntries = await sitemap();
    const urls = siteMapEntries.map((entry) => entry.url);
    expect(urls).toContain(publicOrigin);
    expect(urls).toContain(`${publicOrigin}/competitions`);
    expect(urls).toContain(`${publicOrigin}/pricing`);
    expect(urls).toContain(`${publicOrigin}/support`);
    expect(urls).not.toContain(`${publicOrigin}/notifications`);
    expect(urls).toContain(`${publicOrigin}/competitions/summer-cup`);
    expect(urls).toContain(`${publicOrigin}/competitions/summer-cup/matches/match-1`);
    // A competition whose projection read failed is still listed (the listing proves it is public).
    expect(urls).toContain(`${publicOrigin}/competitions/broken-cup`);
    const competition = siteMapEntries.find((entry) => entry.url === `${publicOrigin}/competitions/summer-cup`);
    expect(competition?.lastModified).toEqual(new Date("2026-09-19T08:30:00.000Z"));
    const match = siteMapEntries.find((entry) => entry.url.endsWith("/matches/match-1"));
    expect(match?.lastModified).toEqual(new Date("2026-09-19T08:00:00.000Z"));
  });

  it("falls back to the Vercel production hostname when MATCHDAY_PUBLIC_ORIGIN is unset", async () => {
    delete process.env.MATCHDAY_PUBLIC_ORIGIN;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "matchday.example";
    try {
      expect((await robots()).sitemap).toBe("https://matchday.example/sitemap.xml");
      expect((await sitemap())[0]?.url).toBe("https://matchday.example");
    } finally {
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    }
  });

  it("does not emit placeholder SEO URLs without any resolvable public origin", async () => {
    delete process.env.MATCHDAY_PUBLIC_ORIGIN;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(await sitemap()).toEqual([]);
    expect((await robots()).sitemap).toBeUndefined();
  });

  it("generates SportsEvent JSON-LD for public competition pages", () => {
    const jsonLd = publicCompetitionJsonLd(
      {
        slug: "summer-cup",
        name: "Summer Cup",
        sport: "Football",
        venue: "Court 1 · Court 2",
        startsOn: "2026-09-19",
        endsOn: "2026-09-20",
        status: "live",
        teams: ["Sharks", "Rays", "TBD"],
      },
      publicOrigin,
    );

    expect(jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "SportsEvent",
      name: "Summer Cup",
      description: "Summer Cup — Football competition.",
      url: `${publicOrigin}/competitions/summer-cup`,
      sport: "Football",
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      startDate: "2026-09-19",
      endDate: "2026-09-20",
      location: { "@type": "Place", name: "Court 1 · Court 2" },
      competitor: [
        { "@type": "SportsTeam", name: "Sharks" },
        { "@type": "SportsTeam", name: "Rays" },
      ],
    });
    expect(JSON.parse(serializeJsonLd(jsonLd!))).toEqual(jsonLd);
  });

  it("generates SportsEvent JSON-LD for public match pages", () => {
    const jsonLd = publicMatchJsonLd(
      { slug: "summer-cup", name: "Summer Cup", sport: "Football", status: "live" },
      {
        id: "match-1",
        home: "Sharks",
        away: "Rays",
        stage: "Group A",
        area: "Court 1",
        startsAt: "2026-09-19T08:00:00Z",
        status: "live",
      },
      publicOrigin,
    );
    expect(jsonLd).toMatchObject({
      "@type": "SportsEvent",
      name: "Sharks v Rays",
      url: `${publicOrigin}/competitions/summer-cup/matches/match-1`,
      startDate: "2026-09-19T08:00:00.000Z",
      location: { "@type": "Place", name: "Court 1" },
      homeTeam: { "@type": "SportsTeam", name: "Sharks" },
      awayTeam: { "@type": "SportsTeam", name: "Rays" },
      superEvent: { "@type": "SportsEvent", name: "Summer Cup", url: `${publicOrigin}/competitions/summer-cup` },
    });
  });

  it("does not emit competition JSON-LD for an invalid origin and safely serializes public text", () => {
    expect(
      publicCompetitionJsonLd({ slug: "summer-cup", name: "Summer Cup", sport: "Football" }, "http://example.com"),
    ).toBeNull();

    const jsonLd = publicCompetitionJsonLd(
      { slug: "summer-cup", name: "</script><script>alert(1)</script>", sport: "Football", teams: ["</script>"] },
      publicOrigin,
    );
    expect(jsonLd).not.toBeNull();
    const serialized = serializeJsonLd(jsonLd!);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized).name).toBe("</script><script>alert(1)</script>");
  });

  it("publishes a dark, installable manifest with standard and maskable icons", () => {
    const value = manifest();
    expect(value).toMatchObject({ id: "/", scope: "/", start_url: "/", background_color: "#111513" });
    expect(value.icons?.map((icon) => `${icon.sizes}:${icon.purpose}`)).toEqual([
      "192x192:any",
      "512x512:any",
      "512x512:maskable",
    ]);
  });
});
