import { describe, expect, it } from "vitest";
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

describe("RES-021 & RES-025 - RES-032 Public Pages and SEO Verification", () => {
  it("renders terms of service page", () => {
    const html = renderToString(React.createElement(TermsPage));
    expect(html).toContain(messages.legal.termsTitle);
  });

  it("renders privacy policy page", () => {
    const html = renderToString(React.createElement(PrivacyPage));
    expect(html).toContain(messages.legal.privacyTitle);
  });

  it("renders cookie policy page", () => {
    const html = renderToString(React.createElement(CookiesPage));
    expect(html).toContain(messages.legal.cookiesTitle);
  });

  it("renders support and FAQ page", () => {
    const html = renderToString(React.createElement(SupportPage));
    expect(html).toContain(messages.support.title.replace("&", "&amp;"));
    expect(html).toContain(messages.support.faqTitle);
    expect(html).toContain(messages.support.contactEmail);
  });

  it("renders pricing page with commercial tiers", () => {
    const html = renderToString(React.createElement(PricingPage));
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

  it("generates correct robots.txt rules", () => {
    const robotRules = robots();
    expect(robotRules.rules).toBeDefined();
    expect(robotRules.sitemap).toBe("https://matchday.example/sitemap.xml");
  });

  it("generates valid sitemap entries with priority and change frequencies", () => {
    const siteMapEntries = sitemap();
    expect(siteMapEntries.length).toBeGreaterThanOrEqual(7);
    const urls = siteMapEntries.map((e) => e.url);
    expect(urls).toContain("https://matchday.example");
    expect(urls).toContain("https://matchday.example/competitions");
    expect(urls).toContain("https://matchday.example/pricing");
    expect(urls).toContain("https://matchday.example/support");
    expect(urls).toContain("https://matchday.example/notifications");
  });
});
