import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

/**
 * Redesign Phase 2 shell. The deployment flag stays off in this demo server, so every test opts in with the
 * local-only preview cookie; the classic shell keeps its own coverage in the other specs.
 */
test.use({ serviceWorkers: "block" });

const competition = "/organiser/competitions/singapore-open";
// The format designer is full screen (no header or tabs), as in the classic shell; it is checked separately.
const setupRoutes = [
  "",
  "/setup",
  "/entries",
  "/capacity",
  "/settings",
  "/schedule",
  "/officials",
  "/publish",
  "/audit",
];
const liveRoutes = ["/live", "/results", "/repairs", "/access", "/audit?mode=live"];
/** Control-room widgets that belong to Live only. */
const liveWidgets = ".p2-live-result, .p2-next, .p2-control-grid";

test.beforeEach(async ({ page, context, baseURL }) => {
  installConsoleGuard(page);
  await context.addCookies([{ name: "matchday-redesign-shell", value: "1", url: baseURL ?? "http://127.0.0.1" }]);
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

async function open(page: Page, path: string) {
  // The demo server has no repairs API; the repairs page shows its own unavailable state.
  if (path === "/repairs") allowConsoleFailure(page, /status of 503/u);
  await page.goto(competition + path);
  await dismissConsent(page);
  await expect(page.getByRole("navigation", { name: "Setup or Live" })).toBeVisible();
}

test("every Setup page uses the Setup tabs and never shows live widgets", async ({ page }) => {
  for (const route of setupRoutes) {
    await open(page, route);
    await expect(page.getByRole("navigation", { name: "Setup sections" }), route).toBeVisible();
    await expect(page.locator(".p2-shell"), route).toHaveAttribute("data-organiser-mode", "setup");
    await expect(page.locator(liveWidgets), route).toHaveCount(0);
    await expect(page.getByText("Live mode", { exact: true }), route).toHaveCount(0);
    // One line of help at most: the heading tip. The shell adds none.
    expect(await page.locator(".p2-page-heading .md-infotip").count(), route).toBeLessThanOrEqual(1);
    expect(await page.locator(".p2-shell__bar .md-infotip, .p2-subnav .md-infotip").count(), route).toBe(0);
  }
});

test("the full-screen format designer shows no live widgets", async ({ page }) => {
  await page.goto(`${competition}/format`);
  await dismissConsent(page);
  await expect(page.locator(".p2-shell")).toHaveAttribute("data-organiser-mode", "setup");
  await expect(page.locator(liveWidgets)).toHaveCount(0);
});

test("every Live page uses the Live tabs and a text label, not colour alone", async ({ page }) => {
  for (const route of liveRoutes) {
    await open(page, route);
    await expect(page.getByRole("navigation", { name: "Live sections" }), route).toBeVisible();
    await expect(page.locator(".p2-shell"), route).toHaveAttribute("data-organiser-mode", "live");
    await expect(page.getByText("Live mode", { exact: true }), route).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Setup or Live" }).getByRole("link", { name: "Live" }),
    ).toHaveAttribute("aria-current", "true");
  }
});

test("the old routes keep working and land on the matching tab", async ({ page }) => {
  const expected: Array<[string, string]> = [
    ["", "Overview"],
    ["/entries", "Teams"],
    ["/capacity", "Venue and dates"],
    ["/settings", "Rules"],
    ["/publish", "Publish"],
    ["/results", "Results and standings"],
    ["/repairs", "Walkovers and corrections"],
    ["/access", "Scoring access"],
  ];
  for (const [route, tab] of expected) {
    await open(page, route);
    await expect(page.locator('.p2-subnav a[aria-current="page"]'), route).toHaveText(tab);
  }
});

test("@a11y keyboard moves between Setup and Live and through the tabs", async ({ page, isMobile }) => {
  test.skip(isMobile, "Keyboard journey runs on desktop.");
  await open(page, "");
  const live = page.getByRole("navigation", { name: "Setup or Live" }).getByRole("link", { name: "Live" });
  await live.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/live$/u);
  await expect(page.getByRole("navigation", { name: "Live sections" })).toBeVisible();
  await page.getByRole("navigation", { name: "Live sections" }).getByRole("link", { name: "Activity" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/audit\?mode=live$/u);
  await expect(page.getByText("Live mode", { exact: true })).toBeVisible();
  const setup = page.getByRole("navigation", { name: "Setup or Live" }).getByRole("link", { name: "Setup" });
  await setup.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/organiser\/competitions\/[^/?]+$/u);
  await expect(page.getByRole("navigation", { name: "Setup sections" })).toBeVisible();
});

test("@a11y the account menu holds the theme choice and closes with Escape", async ({ page }) => {
  await open(page, "");
  const button = page.getByRole("button", { name: "Your account and appearance" });
  const box = await button.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("radio", { name: "Light" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();
  // The choice survives a reload (applied before first paint by the layout script).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await button.click();
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("@a11y redesign shell pages have no WCAG A or AA violations in both themes", async ({ page }) => {
  for (const route of ["", "/entries", "/live", "/audit?mode=live"]) {
    await open(page, route);
    await assertNoWcagAOrAaViolations(page);
  }
});

test("redesign shell screenshots at 375, 768 and 1280 in Dark and Light", async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, "Screenshots are taken once, from the desktop project.");
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"] as const) {
      await page.addInitScript((value) => window.localStorage.setItem("matchday-theme", value), theme);
      for (const [name, route] of [
        ["setup-overview", ""],
        ["live-landing", "/live"],
      ] as const) {
        await open(page, route);
        // No horizontal page scroll at any width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${name} ${theme} ${width}`).toBeLessThanOrEqual(0);
        await testInfo.attach(`${name}-${theme}-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }
  }
});
