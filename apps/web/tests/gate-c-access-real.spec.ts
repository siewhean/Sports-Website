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

async function issuePass(
  page: Page,
  role: "viewer" | "scorekeeper",
  matchId: string,
  exerciseRevealControls = false,
): Promise<RevealedPass> {
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
  await expect(reveal.getByRole("button", { name: "Close" })).toBeFocused();
  await assertNoWcagAOrAaViolations(page);
  if (exerciseRevealControls) {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (value: string) => {
            document.body.setAttribute("data-last-copied-value", value);
            return Promise.resolve();
          },
        },
      });
    });
    await reveal.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-last-copied-value", accessUrl);
    await reveal.getByRole("button", { name: "Copy number" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-last-copied-value", fallbackCode);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")),
        },
      });
    });
    const copyNumber = reveal.getByRole("button", { name: "Copy number" });
    await copyNumber.click();
    await expect(copyNumber).toBeFocused();
    await expect(page.locator('[aria-live="polite"]')).toHaveText(
      "The access command could not be completed. Your current view was preserved.",
    );

    const download = page.waitForEvent("download");
    await reveal.getByRole("button", { name: "Download QR" }).click();
    expect((await download).suggestedFilename()).toMatch(/^matchday-.+-access\.svg$/);

    await page.evaluate(() => {
      Object.defineProperty(window, "print", {
        configurable: true,
        value: () => document.body.setAttribute("data-print-invoked", "true"),
      });
    });
    await reveal.getByRole("button", { name: "Print" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-print-invoked", "true");
  }
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

async function assertAccessSummaryReflows(page: Page): Promise<void> {
  const layout = await page.locator(".p5-access > div").evaluateAll((elements) => {
    const viewportWidth = document.documentElement.clientWidth;
    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rows: elements.map((element, rowIndex) => {
        const rectangle = element.getBoundingClientRect();
        return {
          rowIndex,
          left: rectangle.left,
          right: rectangle.right,
          textContent: element.textContent ?? "",
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      }),
    };
  });

  expect(layout.rows.length).toBeGreaterThan(0);
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  for (const row of layout.rows) {
    expect(row.left).toBeGreaterThanOrEqual(-1);
    expect(row.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    if (Number(process.env.GATE_C_ACCESS_DEBUG_LAYOUT ?? 0)) {
      console.log(
        `layout-check row=${row.rowIndex} left=${row.left} right=${row.right} viewport=${layout.viewportWidth} scroll=${row.scrollWidth} client=${row.clientWidth}`,
      );
      console.log(`layout-check row=${row.rowIndex} text=${JSON.stringify(row.textContent)}`);
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  }
}

async function debugLayoutRows(page: Page, label: string): Promise<void> {
  if (!Number(process.env.GATE_C_ACCESS_DEBUG_LAYOUT ?? 0)) return;

  const rows = await page.locator(".p5-access > div").evaluateAll((elements) =>
    elements.map((element, rowIndex) => ({
      rowIndex,
      count: element.children.length,
      text: element.textContent ?? "",
      childWidths: Array.from(element.children).map((child) => {
        const childRect = child.getBoundingClientRect();
        return {
          tagName: (child as Element).tagName,
          className: (child as Element).className,
          textLength: ((child as Element).textContent ?? "").length,
          textSnippet: ((child as Element).textContent ?? "").slice(0, 64),
          styleDisplay: getComputedStyle(child as Element).display,
          styleWhiteSpace: getComputedStyle(child as Element).whiteSpace,
          scrollWidth: (child as Element).scrollWidth,
          clientWidth: (child as Element).clientWidth,
          rectWidth: childRect.width,
          rectRight: childRect.right,
          rectLeft: childRect.left,
        };
      }),
      className: element.className,
      html: element.innerHTML.slice(0, 140),
    })),
  );
  console.log(`layout-rows label=${label} count=${rows.length}`);
  for (const row of rows) {
    console.log(
      `layout-rows label=${label} row=${row.rowIndex} children=${row.count} text=${JSON.stringify(row.text)}`,
    );
    for (const child of row.childWidths) {
      console.log(
        `layout-rows label=${label} row=${row.rowIndex} childTag=${child.tagName} class=${JSON.stringify(
          child.className,
        )} textLen=${child.textLength} text=${JSON.stringify(child.textSnippet)} display=${child.styleDisplay} whiteSpace=${child.styleWhiteSpace} rectW=${child.rectWidth.toFixed(2)} clientW=${child.clientWidth} scrollW=${child.scrollWidth} left=${child.rectLeft} right=${child.rectRight}`,
      );
    }
  }
}

test("ACC-001–010 issue, read-only, rotate, revoke, transfer and lease lapse", async ({
  browser,
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const state = await seedState();
  const phone = testInfo.project.name.includes("phone");
  if (phone) await page.setViewportSize({ width: 320, height: 800 });
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
  await debugLayoutRows(page, "before-first-assert");
  await assertAccessSummaryReflows(page);

  const viewer = await issuePass(page, "viewer", state.matchId, true);
  await debugLayoutRows(page, "after-issue-pass-before-mutate");
  if (phone) {
    await page
      .locator(".p5-access > div")
      .first()
      .evaluate((row) => {
        const cells = Array.from(row.children);
        const title = cells[0]?.querySelector("strong");
        const detail = cells[0]?.querySelector("small");
        const expiry = cells[2];
        if (title) title.textContent = "International Mixed Under-21 Championship Qualification Match 128";
        if (detail) detail.textContent = "Very Long Home Team Name · Very Long Away Team Name";
        if (expiry) expiry.append(" · 30 September 2026, 23:59:59 Singapore Standard Time");
      });
  }
  await debugLayoutRows(page, "after-manual-mutate");
  await assertAccessSummaryReflows(page);
  if (phone) await attachSurface(page, testInfo, `${testInfo.project.name}-access-summary-320-reflow`);
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
  const rotateViewerPass = viewerHistory.getByRole("button", { name: /Rotate fallback number/ });
  await rotateViewerPass.click();
  const rotatedReveal = page.getByRole("dialog", { name: "Save these access details now" });
  await expect(rotatedReveal).toBeVisible();
  await expect(rotatedReveal.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(rotatedReveal.getByText("Fallback number rotated. Save the new number now.")).toBeVisible();
  await expect(rotatedReveal.getByRole("img", { name: "Scan this QR to open scoring access" })).toHaveCount(0);
  await expect(rotatedReveal.locator("code")).toHaveCount(1);
  const rotatedCode = (await rotatedReveal.locator("code").textContent())?.trim() ?? "";
  expect(rotatedCode).toMatch(/^\d{12}$/);
  expect(rotatedCode).not.toBe(viewer.fallbackCode);
  await assertNoWcagAOrAaViolations(page);
  await rotatedReveal.getByRole("button", { name: "Close" }).click();
  await expect(rotateViewerPass).toBeFocused();

  const fallbackContext = await scoringContext(browser, page, phone);
  const fallbackPage = await fallbackContext.newPage();
  fallbackPage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(fallbackPage, `${state.webOrigin}/score`);
  await fallbackPage.getByLabel("Scoring code").fill(rotatedCode);
  await fallbackPage.getByRole("button", { name: "Validate access" }).click();
  await expect(fallbackPage.locator(".p2-writer")).toContainText("Read only");

  const revokeViewerPass = viewerHistory.getByRole("button", { name: /Revoke pass for/ });
  await revokeViewerPass.click();
  const revoke = page.getByRole("dialog", { name: "Revoke this pass?" });
  await expect(revoke.getByLabel("Reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(revoke).toBeHidden();
  await expect(revokeViewerPass).toBeFocused();
  await revokeViewerPass.click();
  await expect(revoke.getByLabel("Reason")).toBeFocused();
  await revoke.getByRole("button", { name: "Cancel" }).click();
  await expect(revoke).toBeHidden();
  await expect(revokeViewerPass).toBeFocused();
  await revokeViewerPass.click();
  await expect(revoke.getByLabel("Reason")).toBeFocused();
  await revoke.getByLabel("Reason").fill("Viewer access window closed");
  await revoke.getByRole("button", { name: "Revoke pass" }).click();
  await expect(viewerHistory).toContainText("Revoked");
  await expect(viewerHistory.getByText("Revoked", { exact: true })).toBeFocused();
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
  await expect(page.locator('[aria-live="polite"]')).toHaveText("Access pass revoked.");
  allowConsoleFailure(
    viewerPage,
    /^console\.error: Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/,
  );
  await viewerPage.reload();
  await expect(viewerPage.locator("#scoring-code-error")).toHaveText("This scoring access was revoked");
  await expect(viewerPage.locator('[aria-live="polite"]')).toContainText("revoked");
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
  const pendingHeartbeatStatus = await incumbentPage.evaluate(async () => {
    const response = await fetch("/api/scoring/session/heartbeat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastAcknowledgedSequence: 0,
        pendingEventCount: 1,
        pendingThroughSequence: 1,
      }),
    });
    return response.status;
  });
  expect(pendingHeartbeatStatus).toBe(200);
  await incumbentContext.setOffline(true);
  await candidatePage.getByRole("button", { name: "Request scoring access" }).click();
  await expect(candidatePage.getByText("Takeover requested", { exact: true }).last()).toBeVisible();

  const pending = page
    .locator(".p5-takeovers li")
    .filter({ hasText: /scoring device/i })
    .first();
  await expect(pending).toBeVisible({ timeout: 10_000 });
  await expect(pending).toContainText("Active device reports pending events");
  await pending.getByRole("button", { name: "Review" }).click();
  const takeover = page.getByRole("dialog", { name: "Review takeover" });
  await expect(takeover.getByText("Transfer conflict warning", { exact: true })).toBeVisible();
  await expect(
    takeover.getByText(
      "The active device may have unsynchronised events. Approval will fence that device and create a conflict record for organiser review.",
      { exact: true },
    ),
  ).toBeVisible();
  let approveRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/takeover-requests/") && request.url().endsWith("/approve")) approveRequests += 1;
  });
  const approveTakeover = takeover.getByRole("button", { name: "Approve and transfer" });
  await expect(approveTakeover).toBeDisabled();
  await takeover.getByLabel("Decision reason").fill("Approved court-side replacement");
  await expect(approveTakeover).toBeDisabled();
  expect(approveRequests).toBe(0);
  await takeover.getByLabel("I understand that unsynchronised events will not be merged automatically.").check();
  await expect(approveTakeover).toBeEnabled();
  await takeover.getByLabel("Decision reason").fill("");
  await expect(approveTakeover).toBeDisabled();
  expect(approveRequests).toBe(0);
  await takeover.getByLabel("Decision reason").fill("Approved court-side replacement");
  await expect(approveTakeover).toBeEnabled();
  await assertNoWcagAOrAaViolations(page);
  await attachSurface(page, testInfo, `${testInfo.project.name}-takeover-review`);
  const candidateHeartbeat = candidatePage.waitForResponse(
    (response) => response.url().endsWith("/api/scoring/session/heartbeat") && response.status() === 200,
    { timeout: 20_000 },
  );
  await approveTakeover.click();
  await expect.poll(() => approveRequests).toBe(1);
  await expect(
    page.getByText("Takeover approved. A transfer conflict was recorded for organiser review.", { exact: true }),
  ).toBeAttached();

  await expect(candidatePage.locator(".p2-writer")).toContainText("Active scorer", { timeout: 10_000 });
  await expect(candidatePage.getByLabel("Scorer name")).toBeFocused();
  await candidateHeartbeat;
  await incumbentContext.setOffline(false);
  await expect(incumbentPage.locator(".p2-writer")).toContainText("Scoring moved to another device", {
    timeout: 20_000,
  });
  await expect(
    incumbentPage.locator(".p2-writer").filter({ hasText: "Scoring moved to another device" }),
  ).toBeFocused();
  await expect(incumbentPage.getByRole("button", { name: "Review final score" })).toHaveCount(0);
  await expect(incumbentPage.getByLabel("Scorer name")).toBeDisabled();
  await assertNoWcagAOrAaViolations(incumbentPage);
  await attachSurface(incumbentPage, testInfo, `${testInfo.project.name}-transferred-read-only`);

  await candidatePage.close();
  await page.waitForTimeout(48_000);
  candidatePage = await candidateContext.newPage();
  candidatePage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(candidatePage, `${state.webOrigin}/score`);
  await expect(candidatePage.locator(".p2-writer")).toContainText("Writer lease needs reconnection");
  const leaseWarning = candidatePage.locator(".p2-score-warning");
  await expect(leaseWarning).toContainText("Your scoring session and access pass remain valid");
  await expect(leaseWarning).not.toContainText("issue a new pass");
  await expect(candidatePage.getByLabel("Scorer name")).toBeDisabled();
  await expect(candidatePage.locator('[aria-live="polite"]')).toContainText("Writer lease needs reconnection");
  await assertNoWcagAOrAaViolations(candidatePage);
  await attachSurface(candidatePage, testInfo, `${testInfo.project.name}-lease-lapsed`);

  const rateLimitedContext = await scoringContext(browser, page, phone);
  const rateLimitedPage = await rateLimitedContext.newPage();
  rateLimitedPage.on("request", (request) => requestUrls.push(request.url()));
  await openScoring(rateLimitedPage, `${state.webOrigin}/score`);
  allowConsoleFailure(
    rateLimitedPage,
    /^console\.error: Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/,
  );
  allowConsoleFailure(
    rateLimitedPage,
    /^console\.error: Failed to load resource: the server responded with a status of 429 \(Too Many Requests\)$/,
  );
  const rateLimitedMessage = rateLimitedPage.locator("#scoring-code-error");
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await rateLimitedPage.getByLabel("Scoring code").fill("000000000000");
    await rateLimitedPage.getByRole("button", { name: "Validate access" }).click();
    if ((await rateLimitedMessage.textContent()) === "Too many access attempts. Wait before trying again.") break;
  }
  await expect(rateLimitedMessage).toHaveText("Too many access attempts. Wait before trying again.");
  await expect(rateLimitedPage.locator('[aria-live="polite"]')).toContainText("Too many access attempts");
  await assertNoWcagAOrAaViolations(rateLimitedPage);

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
  await assertConsoleGuard(rateLimitedPage, testInfo);
  await incumbentContext.close();
  await candidateContext.close();
  await rateLimitedContext.close();
});
