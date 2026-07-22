import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type GateBRealState = Readonly<{
  webOrigin: string;
  recommendationCompetitionId: string;
  completedCompetitionId: string;
  recommendationName: string;
  organiserCookieName: string;
  organiserCookieValue: string;
}>;

async function readState(): Promise<GateBRealState> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  return JSON.parse(await readFile(file, "utf8")) as GateBRealState;
}

async function authenticate(context: BrowserContext, state: GateBRealState): Promise<void> {
  await context.addCookies([
    {
      name: state.organiserCookieName,
      value: state.organiserCookieValue,
      url: state.webOrigin,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    },
  ]);
}

function trackFailedApplicationResponses(page: Page): string[] {
  const failures: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && (url.includes("/api/") || url.includes("/organiser/"))) {
      failures.push(`${response.status()} ${url}`);
    }
  });
  return failures;
}

test.beforeEach(async ({ page, context }) => {
  const state = await readState();
  await authenticate(context, state);
  await installConsoleGuard(page);
});

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("unselected canonical format recommendations survive real resume and reload", async ({ page }) => {
  const state = await readState();
  const failures = trackFailedApplicationResponses(page);

  await page.goto(`/organiser/competitions/${encodeURIComponent(state.recommendationCompetitionId)}/setup`);
  await dismissConsent(page);

  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  const recommendation = page.locator("article").filter({ hasText: state.recommendationName });
  await expect(recommendation).toBeVisible({ timeout: 15_000 });
  await expect(recommendation.getByRole("button")).toBeEnabled();

  await page.reload();
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expect(page.locator("article").filter({ hasText: state.recommendationName })).toBeVisible({ timeout: 15_000 });
  expect(failures).toEqual([]);
});

test("completed setup is parsed and rendered as a truthful read-only review", async ({ page, context }) => {
  const state = await readState();
  const failures = trackFailedApplicationResponses(page);

  await page.goto(`/organiser/competitions/${encodeURIComponent(state.completedCompetitionId)}/setup`);
  await dismissConsent(page);

  const workspace = page.getByTestId("phase4-assisted-setup");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("status").filter({ hasText: /read.?only/i })).toBeVisible();
  const footerButtons = workspace.locator("footer button");
  const footerButtonCount = await footerButtons.count();
  expect(footerButtonCount).toBeGreaterThan(0);
  for (let index = 0; index < footerButtonCount; index += 1) await expect(footerButtons.nth(index)).toBeDisabled();

  const browserStorage = await page.evaluate(() => ({
    cookie: document.cookie,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(browserStorage.cookie).not.toContain(state.organiserCookieValue);
  expect(JSON.stringify(browserStorage.local)).not.toContain(state.organiserCookieValue);
  expect(JSON.stringify(browserStorage.session)).not.toContain(state.organiserCookieValue);

  const sessionCookies = (await context.cookies()).filter((cookie) => cookie.name === state.organiserCookieName);
  expect(sessionCookies).toHaveLength(1);
  expect(sessionCookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict" });

  await page.reload();
  const reloadedWorkspace = page.getByTestId("phase4-assisted-setup");
  await expect(reloadedWorkspace).toBeVisible();
  await expect(reloadedWorkspace.getByRole("status").filter({ hasText: /read.?only/i })).toBeVisible();
  expect(failures).toEqual([]);
});
