import { appendFile, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
  webOrigin: string;
  competitionId: string;
  organisationId: string;
  divisionId: string;
  slug: string;
  formatRevisionId: string;
  scheduleJobId: string;
  scheduleJobRevision: number;
  scheduleOptionId: string;
  moveTarget: {
    match_id: string;
    match_code: string;
    playing_area_id: string;
    slot_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
  organiserCookie: string;
};

async function state(projectName: string): Promise<State> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, State> };
  const fixture = parsed.projects[projectName];
  if (!fixture) throw new Error(`No real Phase 4 fixture exists for ${projectName}`);
  return fixture;
}

function waitForDocument(page: Page, pathname: string) {
  return {
    response: page.waitForResponse(
      (response) => response.request().resourceType() === "document" && new URL(response.url()).pathname === pathname,
    ),
    loaded: page.waitForEvent("load"),
  };
}

test.afterEach(async ({ page }, testInfo) => {
  await assertConsoleGuard(page, testInfo);
});

test("real organiser setup, template, scheduler, move and publication journey", async ({ page, context }, testInfo) => {
  const seed = await state(testInfo.project.name);
  await installConsoleGuard(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" },
  ]);

  await page.goto(`/organiser/competitions/${seed.competitionId}/format`);
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-format-designer")).toBeVisible();
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  if (testInfo.project.name === "phase-4-real-tablet-webkit") {
    const manualMode = page.getByRole("button", { name: "Manual", exact: true });
    await expect(manualMode).toHaveAttribute("aria-pressed", "false");
    await manualMode.click();
    await expect(manualMode).toHaveAttribute("aria-pressed", "true");
    const stageName = page.getByLabel("Stage name").first();
    await expect(stageName).toBeEnabled();
    await stageName.fill("Browser knockout");
    await expect(stageName).toHaveValue("Browser knockout");
  } else {
    await page.getByRole("button", { name: "Manual", exact: true }).click();
    const stageName = page.getByLabel("Stage name").first();
    await stageName.fill("Browser knockout");
    await expect(stageName).toHaveValue("Browser knockout");
  }
  await expect(saveButton).toBeEnabled();
  const formatValidationRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes(`/format-builder/validate`),
  );
  await page.getByRole("button", { name: "Validate graph" }).click();
  await formatValidationRequest;
  await expect(page.getByText(/Format valid\. \d+ matches can be materialised\./)).toBeVisible();
  await expect(saveButton).toBeEnabled();
  const saveResponse = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith(`/format-builder`),
  );
  await saveButton.click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByText(/Draft revision \d+ saved/)).toBeVisible();
  await page.getByRole("button", { name: "Templates" }).click();
  await page.getByLabel("New template name").fill("Real browser template");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Template “Real browser template” saved.")).toBeVisible();

  await page.goto(`/organiser/competitions/${seed.competitionId}/setup`);
  await expect(page.getByRole("heading", { name: "Start assisted setup" })).toBeVisible();
  const createResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/setup-draft`),
  );
  const initialResumeResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/setup-draft/resume`),
  );
  await page.getByRole("button", { name: "Start setup" }).click();
  expect((await createResponse).status()).toBe(200);
  expect((await initialResumeResponse).status()).toBe(200);
  await expect(page.getByLabel("Competition name")).toHaveValue("Phase 4 Real E2E Cup");

  const resumeResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/setup-draft/resume`),
  );
  await page.reload();
  expect((await resumeResponse).status()).toBe(200);
  const patchResponse = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().endsWith(`/setup-draft`),
  );
  await page.getByLabel("Competition name").fill("Phase 4 Browser Verified Cup");
  expect((await patchResponse).status()).toBe(200);
  await expect(page.getByText("Draft saved").first()).toBeVisible();

  const unpublished = await context.request.get(`${seed.webOrigin}/competitions/${seed.slug}`);
  expect(unpublished.status(), "A private accepted schedule must not appear publicly").toBe(404);

  await page.goto(`/organiser/competitions/${seed.competitionId}/schedule`);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  const generatedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/competitions/${seed.competitionId}/schedule/jobs`),
  );
  await page.getByRole("button", { name: "Generate schedule" }).click();
  expect((await generatedResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Use Balanced" }).first()).toBeVisible({ timeout: 30_000 });
  const schedulePath = `/organiser/competitions/${seed.competitionId}/schedule`;
  const acceptedDocument = waitForDocument(page, schedulePath);
  await page.getByRole("button", { name: "Use Balanced" }).first().click();
  expect((await acceptedDocument.response).status()).toBe(200);
  await acceptedDocument.loaded;
  await page
    .getByRole("button", { name: new RegExp(`^${seed.moveTarget.match_code},`) })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("link", { name: "Move" })).toBeVisible();
  const stillPrivate = await context.request.get(`${seed.webOrigin}/competitions/${seed.slug}`);
  expect(stillPrivate.status(), "An unpublished moved revision must remain private").toBe(404);
  await page.getByRole("link", { name: "Move" }).click();
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  const confirmMove = page.getByRole("button", { name: "Confirm move" });
  const showAllTimes = page.getByRole("button", { name: /Show all \d+ times/ });
  if (await showAllTimes.isVisible()) await showAllTimes.click();
  const targetSlot = page
    .getByTestId("move-slot-choices")
    .locator(`input[type="radio"][value="${seed.moveTarget.slot_id}"]`);
  await expect(targetSlot).toBeVisible();
  await expect(targetSlot).toBeEnabled();
  if (!(await targetSlot.isChecked())) {
    const moveValidationRequest = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().endsWith(`/moves/validate`),
    );
    await targetSlot.check();
    expect((await moveValidationRequest).postDataJSON()).toEqual({
      match_id: seed.moveTarget.match_id,
      playing_area_id: seed.moveTarget.playing_area_id,
      slot_id: seed.moveTarget.slot_id,
      start_epoch_ms: seed.moveTarget.start_epoch_ms,
      end_epoch_ms: seed.moveTarget.end_epoch_ms,
    });
  }
  await expect(confirmMove).toBeEnabled();
  const moveRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/moves`));
  const movedDocument = waitForDocument(page, schedulePath);
  await confirmMove.click();
  const browserMove = (await moveRequest).postDataJSON() as Record<string, unknown>;
  const capturedTarget = {
    match_id: browserMove.match_id,
    playing_area_id: browserMove.playing_area_id,
    slot_id: browserMove.slot_id,
    start_epoch_ms: browserMove.start_epoch_ms,
    end_epoch_ms: browserMove.end_epoch_ms,
  };
  expect(capturedTarget).toEqual({
    match_id: seed.moveTarget.match_id,
    playing_area_id: seed.moveTarget.playing_area_id,
    slot_id: seed.moveTarget.slot_id,
    start_epoch_ms: seed.moveTarget.start_epoch_ms,
    end_epoch_ms: seed.moveTarget.end_epoch_ms,
  });
  const resultFile = process.env.PHASE4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("PHASE4_E2E_RESULT_FILE is required");
  await appendFile(resultFile, `${JSON.stringify({ project: testInfo.project.name, target: capturedTarget })}\n`, {
    mode: 0o600,
  });
  expect((await movedDocument.response).status()).toBe(200);
  await movedDocument.loaded;
  await expect(page).toHaveURL(`/organiser/competitions/${seed.competitionId}/schedule`);
  const publishResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/publish`),
  );
  const publishedDocument = waitForDocument(page, schedulePath);
  await page.getByRole("button", { name: "Publish schedule" }).click();
  expect((await publishResponse).status()).toBe(200);
  expect((await publishedDocument.response).status()).toBe(200);
  await publishedDocument.loaded;

  await page.goto(`/competitions/${seed.slug}`);
  await expect(page.getByRole("heading", { name: "Phase 4 Browser Verified Cup" })).toBeVisible();
  await expect(page.getByText("Schedule 1 · Results 0").first()).toBeVisible();
  const publishedTime = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(seed.moveTarget.start_epoch_ms);
  const publishedMovedFixture = page.locator(".p2-public-fixtures > li").filter({ hasText: publishedTime });
  await expect(publishedMovedFixture).toHaveCount(1);
  await expect(publishedMovedFixture).toContainText("Court 1");
  expect(failedResponses).toEqual([]);
});
