import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  xssCompetitionPath: string;
  xssMaliciousName: string;
};

async function readE2EState(): Promise<Phase7E2EState | null> {
  const statePath = process.env.PHASE7_E2E_STATE_FILE;
  if (!statePath) return null;
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as Phase7E2EState;
  } catch {
    return null;
  }
}

test.describe("QA-014 Browser Stored XSS & DOM Sanitization", () => {
  test("renders malicious script tags inertly without executing arbitrary JavaScript", async ({ page }) => {
    await installConsoleGuard(page);
    const state = await readE2EState();

    // Track if any window-level injected payload executes
    await page.addInitScript(() => {
      (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag = false;
    });

    const targetUrl = state
      ? state.xssCompetitionPath
      : "/c/v1-preview?title=" + encodeURIComponent("Gate D <script>window.__xss_injected_flag=true</script>");

    await page.goto(targetUrl);
    await dismissConsent(page);

    // 1. Verify page rendered safely and displays sanitized title text
    await expect(page.locator("body")).toBeVisible();
    await expect(page.getByText(/Gate D/)).toBeVisible();

    // 2. Assert no executable script element matching the payload exists in DOM
    const unescapedScriptTags = page.locator("script").filter({ hasText: "window.__xss_injected_flag" });
    await expect(unescapedScriptTags).toHaveCount(0);

    // 3. Verify window.__xss_injected_flag remained false (no script execution occurred)
    const injected = await page.evaluate(() => {
      return (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag;
    });

    expect(injected).toBe(false);
  });
});
