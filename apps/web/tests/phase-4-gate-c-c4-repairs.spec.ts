import { expect, test } from "@playwright/test";
import { dismissConsent, installConsoleGuard, assertConsoleGuard } from "./helpers/console-guard";
import { gateCC4Ids, installGateCC4BrowserRoutes } from "./helpers/gate-c-c4";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("Gate C C4 organiser resolves an automatic participant and publishes one repaired schedule", async ({ page }) => {
  const controller = await installGateCC4BrowserRoutes(page);

  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Result repairs" })).toBeVisible();
  await expect(page.getByText("Decisions still required")).toBeVisible();
  await expect(page.getByText("Marina Blue", { exact: true })).toBeVisible();
  await expect(page.getByText("Harbour Gold", { exact: true })).toBeVisible();

  await page.getByLabel("Organiser decision").selectOption("accept_proposed");
  await page.getByLabel("Decision reason").first().fill("Accept the corrected winner before publication.");
  const ready = page.getByRole("button", { name: "Mark ready for publication" });
  await expect(ready).toBeEnabled();
  await ready.click();

  await expect(page.getByText("Repair revision saved.")).toBeVisible();
  expect(controller.revisionRequests).toHaveLength(1);
  expect(controller.revisionRequests[0]).toMatchObject({
    parent_revision_id: gateCC4Ids.revision,
    expected_result_version: 7,
    expected_schedule_version: 4,
    expected_analysis_fingerprint: "a".repeat(64),
    status: "ready",
    decisions: [
      {
        match_id: gateCC4Ids.downstreamMatch,
        slot: "home",
        decision: "accept_proposed",
        reason: "Accept the corrected winner before publication.",
      },
    ],
  });

  await expect(page.getByText("Ready to publish")).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish repaired schedule" });
  await expect(publish).toBeEnabled();
  await publish.click();

  await expect(page.getByText("The repaired schedule is now public.")).toBeVisible();
  expect(controller.publicationRequests).toHaveLength(1);
  expect(controller.publicationRequests[0]).toMatchObject({
    competition_id: "cmp_sgopen_2026",
    repair_id: gateCC4Ids.repair,
    repair_revision_id: gateCC4Ids.readyRevision,
    expected_schedule_version: 4,
    expected_result_version: 7,
    expected_analysis_fingerprint: "a".repeat(64),
  });
});

test("Gate C C4 never offers forbidden protected-match decisions or rescheduling", async ({ page }) => {
  await installGateCC4BrowserRoutes(page, { action: "protected_started_match" });

  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);

  const decision = page.getByLabel("Organiser decision");
  await expect(decision).toBeVisible();
  await expect(decision.locator("option")).toHaveText([
    "—",
    "Keep current participant",
    "Leave protected match unchanged",
  ]);
  await expect(page.getByLabel("New start time")).toHaveCount(0);
  await expect(page.getByLabel("New end time")).toHaveCount(0);
  await expect(page.getByLabel("New playing-area ID")).toHaveCount(0);
});

test("Gate C C4 analyses an atomic pending repair case and verifies fallback export integrity", async ({ page }) => {
  await installGateCC4BrowserRoutes(page);

  await page.goto("/organiser/competitions/singapore-open/repairs");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Corrections awaiting analysis" })).toBeVisible();
  await expect(page.getByText("1 pending")).toBeVisible();

  await page.getByRole("button", { name: "Build affected-match workspace" }).click();
  await expect(page.getByText("0 pending")).toBeVisible();

  const exportResponse = page.waitForResponse(
    (response) => response.url().endsWith("/exports/schedule") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Download published schedule PDF" }).click();
  const response = await exportResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["x-matchday-content-sha256"]).toMatch(/^[a-f0-9]{64}$/u);
  const scoreSheetResponse = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith(`/exports/matches/${gateCC4Ids.correctedMatch}/score-sheet`) &&
      candidate.request().method() === "POST",
  );
  await page.getByTestId(`gate-c-c4-score-sheet-${gateCC4Ids.correctedMatch}`).click();
  expect((await scoreSheetResponse).headers()["content-type"]).toContain("application/pdf");
  await expect(page.getByTestId("gate-c-c4-repair-workspace").getByRole("alert")).toHaveCount(0);
});
