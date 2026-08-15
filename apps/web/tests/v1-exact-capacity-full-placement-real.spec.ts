import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
  apiOrigin: string;
  webOrigin: string;
  organisationId: string;
  fixtureKey: string;
  organiserCookie: string;
};

async function state(projectName: string): Promise<State> {
  const stateFile = process.env.PHASE4_E2E_STATE_FILE;
  if (!stateFile) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(stateFile, "utf8")) as { projects: Record<string, State> };
  const value = parsed.projects[projectName];
  if (!value) throw new Error(`No V1 fixture exists for ${projectName}`);
  return value;
}

async function submit(page: Page, button: Locator, method: string, path: string) {
  const waiting = page.waitForResponse(
    (response) => response.request().method() === method && new URL(response.url()).pathname.endsWith(path),
  );
  await button.click();
  const response = await waiting;
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(400);
  return response;
}

async function addDivision(page: Page, name: string, code: string): Promise<void> {
  await page.getByLabel("Division name").fill(name);
  await page.getByLabel("Division code").fill(code);
  await submit(page, page.getByRole("button", { name: "Add division" }), "POST", "/divisions");
}

async function addTeams(page: Page, divisionName: string, prefix: string): Promise<void> {
  const division = page.getByRole("region", { name: divisionName });
  for (let index = 1; index <= 8; index += 1) {
    const form = division.locator("form").last();
    await form.getByLabel("Entry name").fill(`${prefix} ${index}`);
    await form.getByLabel("Seed").fill(String(index));
    await submit(page, form.getByRole("button", { name: "Add entry" }), "POST", "/entries");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("36 full-placement fixtures schedule, publish, and expose truthful result readiness in exactly 36 slots", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(600_000);
  const seed = await state(testInfo.project.name);
  await installConsoleGuard(page);
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([{ name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" }]);

  const slug = `v1-exact-36-${seed.fixtureKey}`;
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("V1 Exact Capacity Full Placement");
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Sport").selectOption("canoe_polo");
  await page.getByLabel("Venue").fill("Exact Capacity Arena");
  await page.getByLabel("Address", { exact: true }).fill("36 Fixture Road");
  await page.getByLabel("Locality").fill("Singapore");
  await page.getByLabel("Country code").fill("SG");
  await page.getByLabel("Start date").fill("2027-08-01");
  await page.getByLabel("End date").fill("2027-08-01");
  await page.getByLabel("Time zone").fill("Asia/Singapore");
  await page.getByLabel("Locale").fill("en-SG");
  await submit(page, page.getByRole("button", { name: "Create competition" }), "POST", "/api/phase3/competitions");
  await page.waitForURL(/\/organiser\/competitions\/[0-9a-f-]+\/setup$/);
  const competitionId = /\/competitions\/([0-9a-f-]+)\//.exec(page.url())?.[1];
  if (!competitionId) throw new Error(`Missing competition id from ${page.url()}`);

  await page.goto(`/organiser/competitions/${competitionId}/capacity`);
  const firstArea = page.locator("fieldset").first();
  await firstArea.getByLabel("Area name").fill("Court 1");
  await firstArea.getByLabel("Date").fill("2027-08-01");
  await firstArea.getByLabel("Starts", { exact: true }).fill("09:00");
  await firstArea.getByLabel("Ends", { exact: true }).fill("18:00");
  await page.getByRole("button", { name: /add.*area/i }).click();
  const secondArea = page.locator("fieldset").nth(1);
  await secondArea.getByLabel("Area name").fill("Court 2");
  await secondArea.getByLabel("Date").fill("2027-08-01");
  await secondArea.getByLabel("Starts", { exact: true }).fill("09:00");
  await secondArea.getByLabel("Ends", { exact: true }).fill("18:00");
  await submit(page, page.getByRole("button", { name: "Save capacity" }), "PUT", "/capacity");
  await expect(page.getByText("36", { exact: true }).last()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/entries`);
  await addDivision(page, "Open", "OPEN");
  await addTeams(page, "Open", "Open Team");
  await addDivision(page, "Women", "WOMEN");
  await addTeams(page, "Women", "Women Team");
  await expect(page.getByText("16 / 16").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/format`);
  await submit(page, page.getByRole("button", { name: "Show format options" }), "POST", "/v1-format-recommendations");
  const fullPlacement = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Full placement" }) });
  await expect(fullPlacement).toContainText("36 matches");
  await submit(page, fullPlacement.getByRole("button", { name: "Use this format" }), "POST", "/apply");

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  const created = await submit(page, page.getByRole("button", { name: "Generate balanced schedule" }), "POST", "/schedule/jobs");
  const receipt = record(await created.json());
  const jobId = typeof receipt?.id === "string" ? receipt.id : typeof receipt?.job_id === "string" ? receipt.job_id : null;
  if (!jobId) throw new Error(`Schedule job response omitted id: ${JSON.stringify(receipt)}`);

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${seed.apiOrigin}/api/v1/competitions/${competitionId}/schedule/jobs/${jobId}`,
          { headers: { cookie: seed.organiserCookie } },
        );
        if (!response.ok()) return `http-${response.status()}`;
        const payload = record(await response.json());
        const status = typeof payload?.status === "string" ? payload.status : "missing-status";
        const failureClass = typeof payload?.failure_class === "string" ? payload.failure_class : "";
        return failureClass ? `${status}:${failureClass}` : status;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe("completed");

  await page.reload();
  await expect(page.getByRole("button", { name: "Use schedule" })).toBeVisible();
  await submit(page, page.getByRole("button", { name: "Use schedule" }), "POST", "/accept");
  await submit(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  const workspace = await page.request.get(`${seed.apiOrigin}/api/v1/competitions/${competitionId}/schedule-workspace`, {
    headers: { cookie: seed.organiserCookie },
  });
  expect(workspace.status(), await workspace.text()).toBe(200);
  const workspacePayload = record(await workspace.json());
  const currentRevision = record(workspacePayload?.current_revision);
  const assignments = Array.isArray(currentRevision?.assignments) ? currentRevision.assignments : [];
  expect(assignments).toHaveLength(36);

  await page.goto(`/organiser/competitions/${competitionId}/results`);
  const resultProgress = page.locator("section").filter({ has: page.getByRole("heading", { name: "Results" }) }).first();
  await expect(resultProgress).toContainText("0 / 36");

  await page.goto(`/organiser/competitions/${competitionId}/publish`);
  await expect(page.getByRole("button", { name: /create revision/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /schedule/i }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /results/i }).first()).toBeVisible();
  await expect(page.locator(`a[href="/competitions/${slug}"]`)).toBeVisible();
});
