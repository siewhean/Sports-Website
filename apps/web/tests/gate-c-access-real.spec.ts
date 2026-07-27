import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type SeedState = {
  webOrigin: string;
  competitionId: string;
  matchId: string;
  organiserCookie: string;
};

type RevealedPass = {
  accessUrl: string;
  fallbackCode: string;
};

async function seedState(): Promise<SeedState> {
  const file = process.env.PHASE2_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE2_E2E_STATE_FILE is required");
  return JSON.parse(await readFile(file, "utf8")) as SeedState;
}

async function scoringContext(browser: Browser, page: Page, phone: boolean): Promise<BrowserContext> {
  return browser.newContext({
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
    isMobile: phone,
    hasTouch: phone,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
}

async function issuePass(page: Page, role: "viewer" | "scorekeeper", matchId: string): Promise<RevealedPass> {
  await page.getByRole("button", { name: "Issue pass" }).click();
  const issue = page.getByRole("dialog", { name: "Create access pass" });
  await issue.getByLabel("Match").selectOption(matchId);
  await issue.getByLabel("Access role").selectOption(role);
  await issue.getByRole("button", { name: "Create access pass" }).click();

  const reveal = page.getByRole("dialog", { name: "Save these access details now" });
  await expect(reveal).toBeVisible();
  const values = reveal.locator("code");
  await expect(values).toHaveCount(2);
  const accessUrl = (await values.nth(0).textContent())?.trim() ?? "";
  const fallbackCode = (await values.nth(1).textContent())?.trim() ?? "";
  expect(accessUrl).toMatch(/^https:\/\/localhost:3102\/score#access=[A-Za-z0-9_-]{32,}$/);
  expect(fallbackCode).toMatch(/^\d{12}$/);
  await expect(reveal.getByRole("img", { name: "Scan this QR to open scoring access" })).toBeVisible();
  await reveal.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Issue pass" })).toBeFocused();
  return { accessUrl, fallbackCode };
}

async function openScoring(page: Page, url: string): Promise<void> {
  await installConsoleGuard(page);
  await page.goto(url);
  await dismissConsent(page);
  await expect(page).toHaveURL(/\/score$/);
}

async function attachSurface(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
}

test("ACC-001–010 issue, read-only, rotate, revoke, transfer and lease expiry", async ({
  browser,
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const state = await seedState();
  const phone = testInfo.project.name.includes("phone");
  const [, organiserCookie] = state.organiserCookie.split("=", 2);
  if (!organiserCookie) throw new Error("Organiser cookie fixture is malformed");
  await context.addCookies([
    {
      name: "matchday_session",
      value: organiserCookie,
      url: state.webOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await installConsoleGuard(page);
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.goto(`/organiser/competitions/${state.competitionId}/access`);
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Match-scoped passes" })).toBeVisible();
  await assertNoWcagAOrAaViolations(page);

  const viewer = await issuePass(page, "viewer", state.matchId);
  const viewerContext = await scoringContext(browser, page, phone);
  const viewerPage = await viewerContext.newPage();
  viewerPage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(viewerPage, viewer.accessUrl);
  await expect(viewerPage.locator(".p2-writer")).toContainText("Read only");
  await expect(viewerPage.getByRole("button", { name: "Review final score" })).toHaveCount(0);
  await expect(viewerPage.getByLabel("Scorer name")).toBeDisabled();
  await expect(viewerPage.getByLabel("Period")).toBeDisabled();
  await expect(viewerPage.getByLabel("Event time")).toBeDisabled();

  await viewerPage.getByRole("button", { name: "Edit device name" }).click();
  await viewerPage.getByLabel("Device name").fill("Court-side viewer");
  await viewerPage.getByRole("button", { name: "Save", exact: true }).click();
  await expect(viewerPage.getByText("Court-side viewer", { exact: true })).toBeVisible();
  await expect(viewerPage.getByRole("button", { name: "Edit device name" })).toBeFocused();
  await assertNoWcagAOrAaViolations(viewerPage);
  await attachSurface(viewerPage, testInfo, `${testInfo.project.name}-viewer-read-only`);

  const viewerHistory = page.locator(".p5-access-history li").filter({ hasText: "Viewer — read only" }).first();
  await viewerHistory.getByRole("button", { name: /Rotate fallback number/ }).click();
  const rotatedReveal = page.getByRole("dialog", { name: "Save these access details now" });
  await expect(rotatedReveal).toBeVisible();
  await expect(rotatedReveal.getByText("Fallback number rotated. Save the new number now.")).toBeVisible();
  await expect(rotatedReveal.getByRole("img", { name: "Scan this QR to open scoring access" })).toHaveCount(0);
  await expect(rotatedReveal.locator("code")).toHaveCount(1);
  const rotatedCode = (await rotatedReveal.locator("code").textContent())?.trim() ?? "";
  expect(rotatedCode).toMatch(/^\d{12}$/);
  expect(rotatedCode).not.toBe(viewer.fallbackCode);
  await rotatedReveal.getByRole("button", { name: "Close" }).click();

  const fallbackContext = await scoringContext(browser, page, phone);
  const fallbackPage = await fallbackContext.newPage();
  fallbackPage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(fallbackPage, `${state.webOrigin}/score`);
  await fallbackPage.getByLabel("Scoring code").fill(rotatedCode);
  await fallbackPage.getByRole("button", { name: "Validate access" }).click();
  await expect(fallbackPage.locator(".p2-writer")).toContainText("Read only");

  await viewerHistory.getByRole("button", { name: /Revoke pass for/ }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke this pass?" });
  await revoke.getByLabel("Reason").fill("Viewer access window closed");
  await revoke.getByRole("button", { name: "Revoke pass" }).click();
  await expect(viewerHistory).toContainText("Revoked");
  allowConsoleFailure(
    viewerPage,
    /^console\.error: Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/,
  );
  await viewerPage.reload();
  await expect(viewerPage.locator("#scoring-code-error")).toHaveText("This scoring access was revoked");
  await assertConsoleGuard(viewerPage, testInfo);
  await assertConsoleGuard(fallbackPage, testInfo);
  await viewerContext.close();
  await fallbackContext.close();

  const incumbentPass = await issuePass(page, "scorekeeper", state.matchId);
  const incumbentContext = await scoringContext(browser, page, phone);
  const incumbentPage = await incumbentContext.newPage();
  incumbentPage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(incumbentPage, incumbentPass.accessUrl);
  await incumbentPage.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await incumbentPage.getByRole("button", { name: "Start scoring" }).click();
  await expect(incumbentPage.locator(".p2-writer")).toContainText("Active scorer");

  const candidatePass = await issuePass(page, "scorekeeper", state.matchId);
  const candidateContext = await scoringContext(browser, page, phone);
  let candidatePage = await candidateContext.newPage();
  candidatePage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(candidatePage, candidatePass.accessUrl);
  await expect(candidatePage.locator(".p2-writer")).toContainText("Waiting for takeover");
  await candidatePage.getByRole("button", { name: "Request scoring access" }).click();
  await expect(candidatePage.getByText("Takeover requested", { exact: true }).last()).toBeVisible();

  await page.reload();
  const pending = page
    .locator(".p5-takeovers li")
    .filter({ hasText: /scoring device/i })
    .first();
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "Review" }).click();
  const takeover = page.getByRole("dialog", { name: "Review takeover" });
  await assertNoWcagAOrAaViolations(page);
  await attachSurface(page, testInfo, `${testInfo.project.name}-takeover-review`);
  await takeover.getByLabel("Decision reason").fill("Approved court-side replacement");
  await takeover.getByRole("button", { name: "Approve and transfer" }).click();
  await expect(page.getByText("Takeover approved.", { exact: true })).toBeAttached();

  await candidatePage.reload();
  await expect(candidatePage.locator(".p2-writer")).toContainText("Active scorer");
  await incumbentPage.reload();
  await expect(incumbentPage.locator(".p2-writer")).toContainText("Scoring moved to another device");
  await expect(incumbentPage.getByRole("button", { name: "Review final score" })).toHaveCount(0);
  await expect(incumbentPage.getByLabel("Scorer name")).toBeDisabled();
  await assertNoWcagAOrAaViolations(incumbentPage);
  await attachSurface(incumbentPage, testInfo, `${testInfo.project.name}-transferred-read-only`);

  await candidatePage.close();
  await page.waitForTimeout(46_000);
  candidatePage = await candidateContext.newPage();
  candidatePage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(candidatePage, `${state.webOrigin}/score`);
  await expect(candidatePage.locator(".p2-writer")).toContainText("This scoring session has expired");
  await assertNoWcagAOrAaViolations(candidatePage);
  await attachSurface(candidatePage, testInfo, `${testInfo.project.name}-lease-expired`);

  for (const secret of [
    viewer.accessUrl.split("#access=")[1],
    viewer.fallbackCode,
    rotatedCode,
    incumbentPass.accessUrl.split("#access=")[1],
    candidatePass.accessUrl.split("#access=")[1],
  ]) {
    expect(requestUrls.join("\n")).not.toContain(secret);
  }
  expect(requestUrls.some((url) => /\/score\/[^/?#]+/.test(new URL(url).pathname))).toBe(false);

  await assertConsoleGuard(page, testInfo);
  await assertConsoleGuard(incumbentPage, testInfo);
  await assertConsoleGuard(candidatePage, testInfo);
  await incumbentContext.close();
  await candidateContext.close();
});
