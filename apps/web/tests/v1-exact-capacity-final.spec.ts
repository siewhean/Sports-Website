import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = { apiOrigin: string; webOrigin: string; organisationId: string; fixtureKey: string; organiserCookie: string };
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
async function state(project: string): Promise<State> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, State> };
  const value = parsed.projects[project];
  if (!value) throw new Error(`Missing fixture for ${project}`);
  return value;
}
async function submit(page: Page, button: Locator, method: string, suffix: string) {
  const wait = page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix));
  await button.click();
  const response = await wait;
  expect(response.status(), `${method} ${suffix}: ${await response.text()}`).toBeLessThan(400);
  return response;
}
async function addDivision(page: Page, name: string, code: string) {
  await page.getByLabel("Division name").fill(name);
  await page.getByLabel("Division code").fill(code);
  await submit(page, page.getByRole("button", { name: "Add division" }), "POST", "/divisions");
}
async function addTeams(page: Page, divisionName: string, prefix: string) {
  const division = page.getByRole("region", { name: divisionName });
  for (let i = 1; i <= 8; i += 1) {
    const form = division.locator("form").last();
    await form.getByLabel("Entry name").fill(`${prefix} ${i}`);
    await form.getByLabel("Seed").fill(String(i));
    await submit(page, form.getByRole("button", { name: "Add entry" }), "POST", "/entries");
  }
}

test.afterEach(async ({ page }, info) => assertConsoleGuard(page, info));

test("full-placement 36 fixtures schedule and publish in exactly 36 slots", async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const seed = await state(info.project.name);
  await installConsoleGuard(page);
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([{ name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" }]);
  const slug = `exact-36-${seed.fixtureKey}`;

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("Exact Capacity Full Placement");
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Sport").selectOption("canoe_polo");
  await page.getByLabel("Venue").fill("Exact Capacity Arena");
  await page.getByLabel("Address", { exact: true }).fill("36 Fixture Road");
  await page.getByLabel("Locality").fill("Singapore");
  await page.getByLabel("Country code").fill("SG");
  await page.getByLabel("Start date").fill("2027-08-01");
  await page.getByLabel("End date").fill("2027-08-01");
  await page.getByLabel("Time zone").selectOption("Asia/Singapore");
  await page.getByLabel("Locale").fill("en-SG");
  await submit(page, page.getByRole("button", { name: "Create competition" }), "POST", "/api/phase3/competitions");
  await page.waitForURL(/\/organiser\/competitions\/[0-9a-f-]+\/setup$/);
  const competitionId = /\/competitions\/([0-9a-f-]+)\//.exec(page.url())?.[1];
  if (!competitionId) throw new Error("Competition id missing");

  await page.goto(`/organiser/competitions/${competitionId}/capacity`);
  const first = page.locator("fieldset").first();
  await first.getByLabel("Area name").fill("Court 1");
  await first.getByLabel("Date").fill("2027-08-01");
  await first.getByLabel("Starts", { exact: true }).fill("09:00");
  await first.getByLabel("Ends", { exact: true }).fill("18:00");
  await page.getByRole("button", { name: /add.*area/i }).click();
  const second = page.locator("fieldset").nth(1);
  await second.getByLabel("Area name").fill("Court 2");
  await second.getByLabel("Date").fill("2027-08-01");
  await second.getByLabel("Starts", { exact: true }).fill("09:00");
  await second.getByLabel("Ends", { exact: true }).fill("18:00");
  await submit(page, page.getByRole("button", { name: "Save capacity" }), "PUT", "/capacity");

  await page.goto(`/organiser/competitions/${competitionId}/entries`);
  await addDivision(page, "Open", "OPEN");
  await addTeams(page, "Open", "Open Team");
  await addDivision(page, "Women", "WOMEN");
  await addTeams(page, "Women", "Women Team");
  await expect(page.getByText("16 / 16").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/format`);
  await submit(page, page.getByRole("button", { name: "Show format options" }), "POST", "/v1-format-recommendations");
  const full = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Full placement" }) });
  await expect(full.getByText("Total matches", { exact: true }).locator("..").locator("dd")).toHaveText("36");
  await expect(full.getByText("Slots available", { exact: true }).locator("..").locator("dd")).toHaveText("36");
  await submit(page, full.getByRole("button", { name: "Use this format" }), "POST", "/apply");

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  const created = await submit(page, page.getByRole("button", { name: "Generate balanced schedule" }), "POST", "/schedule/jobs");
  const envelope = record(await created.json());
  const job = record(envelope?.job);
  const jobId = typeof job?.id === "string" ? job.id : null;
  if (!jobId) throw new Error(`Schedule job response omitted job.id: ${JSON.stringify(envelope)}`);

  await expect.poll(async () => {
    const response = await page.request.get(`${seed.apiOrigin}/api/v1/competitions/${competitionId}/schedule/jobs/${jobId}`, { headers: { cookie: seed.organiserCookie } });
    if (!response.ok()) return `http-${response.status()}`;
    const payload = record(await response.json());
    const status = typeof payload?.status === "string" ? payload.status : "missing";
    const failure = typeof payload?.failure_class === "string" ? payload.failure_class : "";
    return failure ? `${status}:${failure}` : status;
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe("completed");

  await page.reload();
  await expect(page.getByRole("button", { name: "Use schedule" })).toBeVisible({ timeout: 30_000 });
  await submit(page, page.getByRole("button", { name: "Use schedule" }), "POST", "/accept");
  await submit(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  const workspace = await page.request.get(`${seed.apiOrigin}/api/v1/competitions/${competitionId}/schedule-workspace`, { headers: { cookie: seed.organiserCookie } });
  expect(workspace.status(), await workspace.text()).toBe(200);
  const payload = record(await workspace.json());
  const revision = record(payload?.current_revision);
  const assignments = Array.isArray(revision?.assignments) ? revision.assignments : [];
  expect(assignments).toHaveLength(36);

  await page.goto(`/organiser/competitions/${competitionId}/results`);
  await expect(page.getByText("0 / 36", { exact: true })).toBeVisible();
  await page.goto(`/organiser/competitions/${competitionId}/publish`);
  await expect(page.getByText("Scheduled fixtures", { exact: true }).locator("..").locator("dd")).toHaveText("36");
  await expect(page.locator(`a[href="/competitions/${slug}"]`)).toBeVisible();
});
