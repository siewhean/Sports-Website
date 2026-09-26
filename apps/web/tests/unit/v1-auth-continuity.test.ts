import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { cookieHostMatches } from "../../lib/phase2-organiser";

const originalApiBaseUrl = process.env.MATCHDAY_API_BASE_URL;

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.MATCHDAY_API_BASE_URL;
  else process.env.MATCHDAY_API_BASE_URL = originalApiBaseUrl;
});

describe("V1 authenticated competition continuity", () => {
  it("forwards the session to the explicitly configured API across a split web/API host", () => {
    process.env.MATCHDAY_API_BASE_URL = "https://api.matchday.test";

    expect(cookieHostMatches("web.matchday.test", "api.matchday.test")).toBe(true);
    expect(cookieHostMatches("web.matchday.test", "api.matchday.test.evil")).toBe(false);
  });

  it("keeps shared headers identity-aware on public and app-shell pages", async () => {
    const identitySource = await readFile(
      new URL("../../components/foundation/IdentityStatus.tsx", import.meta.url),
      "utf8",
    );
    const chromeSource = await readFile(new URL("../../components/foundation/SiteChrome.tsx", import.meta.url), "utf8");
    const shellSource = await readFile(
      new URL("../../components/foundation/ProductionShell.tsx", import.meta.url),
      "utf8",
    );
    const organiserWorkspaceSource = await readFile(
      new URL("../../components/phase2/OrganiserWorkspace.tsx", import.meta.url),
      "utf8",
    );
    const signInSource = await readFile(new URL("../../app/sign-in/page.tsx", import.meta.url), "utf8");

    expect(identitySource).toContain('fetch("/api/identity/current"');
    expect(identitySource).toContain('credentials: "same-origin"');
    expect(identitySource).toContain('data-identity-state="authenticated"');
    expect(chromeSource).toContain("<IdentityStatus");
    expect(shellSource).toContain("<IdentityStatus");
    expect(organiserWorkspaceSource).toContain("<IdentityStatus");
    expect(signInSource).toContain("readCurrentIdentitySession");
    expect(signInSource).toContain('redirect("/organiser")');

    const identityRouteSource = await readFile(
      new URL("../../app/api/identity/current/route.ts", import.meta.url),
      "utf8",
    );
    expect(identityRouteSource).toContain("readCurrentIdentitySession");
    expect(identityRouteSource).toContain("identityStatusResponseHeaders");
    expect(identityRouteSource).toContain("session.identity.displayName");
  });

  it("passes authenticated server identity into public page headers before hydration", async () => {
    const paths = [
      "../../app/page.tsx",
      "../../app/competitions/[slug]/page.tsx",
      "../../app/competitions/singapore-open/page.tsx",
      "../../app/pricing/page.tsx",
      "../../app/privacy/page.tsx",
      "../../app/terms/page.tsx",
      "../../app/cookies/page.tsx",
    ];

    for (const path of paths) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source).toContain("readCurrentIdentitySession");
      expect(source).toContain('session.status === "authenticated"');
    }

    const marketing = await readFile(new URL("../../components/marketing/MarketingHome.tsx", import.meta.url), "utf8");
    const publicCompetition = await readFile(
      new URL("../../components/phase2/PublicCompetition.tsx", import.meta.url),
      "utf8",
    );
    const legal = await readFile(new URL("../../components/foundation/LegalPage.tsx", import.meta.url), "utf8");

    expect(marketing).toContain("<SiteHeader inverse viewer={viewer} />");
    expect(publicCompetition).toContain("<SiteHeader viewer={viewer} />");
    expect(legal).toContain("<SiteHeader viewer={viewer} />");
  });

  it("hydrates the public competitions header from the authenticated identity", async () => {
    const pageSource = await readFile(new URL("../../app/competitions/page.tsx", import.meta.url), "utf8");
    const listSource = await readFile(
      new URL("../../components/phase2/PublicCompetitionsList.tsx", import.meta.url),
      "utf8",
    );

    expect(pageSource).toContain("readCurrentIdentitySession");
    expect(pageSource).toContain("session.identity.displayName");
    expect(pageSource).toContain("viewer={viewer}");
    expect(listSource).toContain("<SiteHeader viewer={viewer} />");
  });
});
