import { appendFile, readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
  apiOrigin: string;
  webOrigin: string;
  organisationId: string;
  fixtureKey: string;
  organiserCookie: string;
};

type JourneyResult = {
  project: string;
  competitionId: string;
  slug: string;
  divisionIds: [string, string];
  matchId: string;
  moved: { match_id: string; playing_area_id: string; start_epoch_ms: number; end_epoch_ms: number };
};

async function state(projectName: string): Promise<State> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, State> };
  const fixture = parsed.projects[projectName];
  if (!fixture) throw new Error(`No V1 fixture exists for ${projectName}`);
  return fixture;
}

async function submit(page: Page, button: Locator, method: string, path: string) {
  const response = page.waitForResponse(
    (candidate) => candidate.request().method() === method && new URL(candidate.url()).pathname.endsWith(path),
  );
  await button.click();
  const received = await response;
  expect(received.status(), `${method} ${path}: ${await received.text()}`).toBeLessThan(400);
  return received;
}

async function addDivision(page: Page, name: string, code: string): Promise<string> {
  await page.getByLabel("Division name").fill(name);
  await page.getByLabel("Division code").fill(code);
  const response = await submit(page, page.getByRole("button", { name: "Add division" }), "POST", "/divisions");
  const payload = (await response.json()) as { division?: { id?: string }; id?: string };
  const id = payload.division?.id ?? payload.id;
  if (!id) throw new Error(`Division response omitted id: ${JSON.stringify(payload)}`);
  return id;
}

async function addTeams(page: Page, divisionName: string, prefix: string) {
  const division = page.getByRole("region", { name: divisionName });
  for (let index = 1; index <= 4; index += 1) {
    // Entries refresh the server view after each successful mutation. Reacquire
    // the add form instead of keeping a detached pre-refresh locator.
    const createEntry = division.locator("form").last();
    await createEntry.getByLabel("Entry name").fill(`${prefix} ${index}`);
    if (index !== 4) await createEntry.getByLabel("Seed").fill(String(index));
    await submit(page, createEntry.getByRole("button", { name: "Add entry" }), "POST", "/entries");
  }
}

async function issuePass(page: Page, matchId: string): Promise<string> {
  await page.getByRole("button", { name: "Issue pass" }).click();
  const issue = page.getByRole("dialog", { name: "Create access pass" });
  await issue.getByLabel("Match").selectOption(matchId);
  await issue.getByLabel("Access role").selectOption("scorekeeper");
  await issue.getByRole("button", { name: "Create access pass" }).click();
  const reveal = page.getByRole("dialog", { name: "Save these access details now" });
  await expect(reveal).toBeVisible();
  const accessUrl = (await reveal.locator("code").first().textContent())?.trim() ?? "";
  expect(accessUrl).toMatch(/\/score#access=[A-Za-z0-9_-]{32,}$/);
  await reveal.getByRole("button", { name: "Close" }).click();
  return accessUrl;
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("browser owns the simple V1 organiser journey", async ({ page, context }, testInfo) => {
  const seed = await state(testInfo.project.name);
  await installConsoleGuard(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" },
  ]);

  const slug = `v1-browser-${seed.fixtureKey}`;
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("V1 Browser Cup");
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Sport").selectOption("canoe_polo");
  await page.getByLabel("Venue").fill("V1 Arena");
  await page.getByLabel("Address", { exact: true }).fill("1 Matchday Road");
  await page.getByLabel("Locality").fill("Singapore");
  await page.getByLabel("Country code").fill("SG");
  await page.getByLabel("Start date").fill("2027-08-01");
  await page.getByLabel("End date").fill("2027-08-02");
  await page.getByLabel("Time zone").fill("Asia/Singapore");
  await page.getByLabel("Locale").fill("en-SG");
  await submit(page, page.getByRole("button", { name: "Create competition" }), "POST", "/api/phase3/competitions");
  await page.waitForURL(/\/organiser\/competitions\/[0-9a-f-]+\/setup$/);
  const competitionId = /\/competitions\/([0-9a-f-]+)\//.exec(page.url())?.[1];
  if (!competitionId) throw new Error(`Missing competition id from ${page.url()}`);

  await page.goto(`/organiser/competitions/${competitionId}/capacity`);
  const area = page.locator("fieldset").first();
  await area.getByLabel("Area name").fill("Court 1");
  await expect(area.getByLabel("Match slot (minutes)")).toHaveValue("30");
  await area.getByLabel("Date").first().fill("2027-08-01");
  await area.getByLabel("Starts", { exact: true }).first().fill("08:00");
  await area.getByLabel("Ends", { exact: true }).first().fill("18:00");
  await area.getByRole("button", { name: "Add window" }).click();
  await area.getByLabel("Date").nth(1).fill("2027-08-02");
  await area.getByLabel("Starts", { exact: true }).nth(1).fill("08:00");
  await area.getByLabel("Ends", { exact: true }).nth(1).fill("18:00");
  await submit(page, page.getByRole("button", { name: "Save capacity" }), "PUT", "/capacity");

  await page.goto(`/organiser/competitions/${competitionId}/entries`);
  const openId = await addDivision(page, "Open", "OPEN");
  const womenId = await addDivision(page, "Women", "WOMEN");
  await addTeams(page, "Open", "Open Team");
  await addTeams(page, "Women", "Women Team");
  await expect(page.getByText("8 / 16").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/format`);
  await expect(page.getByTestId("v1-format-picker")).toBeVisible();
  await submit(page, page.getByRole("button", { name: "Show format options" }), "POST", "/v1-format-recommendations");
  const apply = page.getByRole("button", { name: "Use this format" }).first();
  await expect(apply).toBeEnabled();
  await submit(page, apply, "POST", "/apply");
  await expect(page.getByTestId("v1-format-selected")).toBeVisible();

  const privatePublic = await page.goto(`/competitions/${slug}`);
  expect(privatePublic?.status()).toBe(404);

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  await expect(page.getByRole("heading", { name: "Balanced schedule", exact: true })).toBeVisible();
  await submit(page, page.getByRole("button", { name: "Generate balanced schedule" }), "POST", "/schedule/jobs");
  await expect(page.getByRole("button", { name: "Use schedule" })).toBeVisible({ timeout: 60_000 });
  await submit(page, page.getByRole("button", { name: "Use schedule" }), "POST", "/accept");
  const matchButton = page.locator("button[aria-pressed]").filter({ visible: true }).first();
  await matchButton.click();
  const moveLink = page.getByRole("link", { name: "Move match" });
  const moveHref = await moveLink.getAttribute("href");
  const matchId = /\/matches\/([0-9a-f-]+)\/move/.exec(moveHref ?? "")?.[1];
  if (!matchId) throw new Error(`Could not read match id from ${moveHref}`);
  await moveLink.click();
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  const selected = page.getByTestId("move-slot-choices").locator('input[type="radio"]:not([disabled])').first();
  await selected.check();
  const moveRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/moves"));
  await page.getByRole("button", { name: "Confirm move" }).click();
  const moved = (await moveRequest).postDataJSON() as JourneyResult["moved"];
  await page.waitForURL(new RegExp(`/organiser/competitions/${competitionId}/schedule`));
  await submit(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  await page.goto(`/competitions/${slug}`);
  await expect(page.getByRole("heading", { name: "V1 Browser Cup" })).toBeVisible();
  const publicMoved = page.locator(`.p2-public-fixtures > li[data-match-id="${moved.match_id}"]`);
  await expect(publicMoved).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const accessUrl = await issuePass(page, matchId);
  await page.goto(accessUrl);
  await expect(page).toHaveURL(`${seed.webOrigin}/score`);
  await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  const goal = page.getByRole("button", { name: /Goal / }).first();
  const goalName = await goal.getAttribute("aria-label");
  await goal.click();
  const confirmation = page.getByRole("dialog", { name: "Confirm goal" });
  await confirmation.getByLabel("Scorer or participant name").fill("Aisha Tan");
  await confirmation.getByRole("button", { name: /Record goal/ }).click();
  await page.getByRole("button", { name: "Review final score" }).click();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
  await page.getByRole("link", { name: "Open public page" }).click();
  await expect(page).toHaveURL(`${seed.webOrigin}/competitions/${slug}`);
  await expect(page.getByText("Aisha Tan")).toHaveCount(0);
  expect(goalName).toBeTruthy();

  const resultFile = process.env.PHASE4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("PHASE4_E2E_RESULT_FILE is required");
  await appendFile(
    resultFile,
    `${JSON.stringify({ project: testInfo.project.name, competitionId, slug, divisionIds: [openId, womenId], matchId, moved } satisfies JourneyResult)}\n`,
    { mode: 0o600 },
  );
  expect(failedResponses).toEqual([`404 GET ${seed.webOrigin}/competitions/${slug}`]);
});
