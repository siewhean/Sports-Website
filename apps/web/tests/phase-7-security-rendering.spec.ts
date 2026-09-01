import { test, expect } from "@playwright/test";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.describe("QA-014 Browser Stored XSS & DOM Sanitization", () => {
  test("renders malicious script tags inertly without executing arbitrary JavaScript", async ({ page }) => {
    await installConsoleGuard(page);

    // Track if any window-level injected payload executes
    await page.addInitScript(() => {
      (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag = false;
    });

    const maliciousName = "Malicious Tournament <script>window.__xss_injected_flag = true;</script>";
    const encodedPayload = encodeURIComponent(maliciousName);

    await page.goto(`/c/v1-preview?title=${encodedPayload}`);
    await dismissConsent(page);

    // Verify page rendered safely
    await expect(page.locator("body")).toBeVisible();

    // Verify window.__xss_injected_flag remained false (no script execution occurred)
    const injected = await page.evaluate(() => {
      return (window as unknown as { __xss_injected_flag?: boolean }).__xss_injected_flag;
    });

    expect(injected).toBe(false);
  });
});
