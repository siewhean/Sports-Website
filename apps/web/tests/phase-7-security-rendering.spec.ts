import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  xssCompetitionPath: string;
  xssMaliciousName: string;
};

async function readE2EState(): Promise<Phase7E2EState> {
  const statePath = process.env.PHASE7_E2E_STATE_FILE;
  if (!statePath) {
    throw new Error("PHASE7_E2E_STATE_FILE is required for Gate D stored-XSS qualification");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Phase 7 E2E state from ${statePath}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Phase 7 E2E state must be a JSON object");
  }

  const state = parsed as Partial<Phase7E2EState>;
  if (typeof state.xssCompetitionPath !== "string" || state.xssCompetitionPath.length === 0) {
    throw new Error("Phase 7 E2E state is missing xssCompetitionPath");
  }
  if (typeof state.xssMaliciousName !== "string" || !state.xssMaliciousName.includes("<script>")) {
    throw new Error("Phase 7 E2E state is missing the persisted malicious XSS value");
  }

  return state as Phase7E2EState;
}

test.describe("QA-014 Browser Stored XSS & DOM Sanitization", () => {
  test("renders the persisted malicious value as inert text without executing JavaScript", async ({ page }) => {
    await installConsoleGuard(page);
    const state = await readE2EState();

    await page.addInitScript(() => {
      (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag = false;
    });

    // No query-string/demo fallback is allowed: this route must resolve the database-backed fixture.
    await page.goto(state.xssCompetitionPath);
    await dismissConsent(page);

    await expect(page.locator("body")).toBeVisible();

    // The exact persisted payload must be present as text. This prevents the test from
    // passing merely because the page ignores the malicious database value.
    await expect(page.getByText(state.xssMaliciousName, { exact: true })).toBeVisible();

    // No executable script node containing the persisted payload may reach the DOM.
    const unescapedScriptTags = page.locator("script").filter({ hasText: "window.__xss_injected_flag" });
    await expect(unescapedScriptTags).toHaveCount(0);

    const injected = await page.evaluate(() => {
      return (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag;
    });
    expect(injected).toBe(false);
  });
});
