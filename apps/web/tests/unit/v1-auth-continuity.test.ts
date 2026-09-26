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

    expect(identitySource).toContain('fetch("/api/v1/identity/me"');
    expect(identitySource).toContain('credentials: "same-origin"');
    expect(identitySource).toContain('data-identity-state="authenticated"');
    expect(chromeSource).toContain("<IdentityStatus");
    expect(shellSource).toContain("<IdentityStatus");
    expect(organiserWorkspaceSource).toContain("<IdentityStatus");
    expect(signInSource).toContain("readCurrentIdentitySession");
    expect(signInSource).toContain('redirect("/organiser")');
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
