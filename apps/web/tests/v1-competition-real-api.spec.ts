import { appendFile, readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
  webOrigin: string;
  organisationId: string;
  fixtureKey: string;
  organiserCookie: string;
};

type JourneyReceipt = {
  project: string;
  competitionId: string;
  slug: string;
  divisionId: string;
  groupMatchIds: string[];
  progressedMatchIds: string[];
};

async function state(projectName: string): Promise<State> {
  const stateFile = process.env.PHASE4_E2E_STATE_FILE;
  if (!stateFile) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(stateFile, "utf8")) as { projects: Record<string, State> };
  const value = parsed.projects[projectName];
  if (!value) throw new Error(`No V1 competition fixture exists for ${projectName}`);
  return value;
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

async function addDivision(page: Page): Promise<string> {
  await page.getByLabel("Division name").fill("Championship");
  await page.getByLabel("Division code").fill("CHAMP");
  const response = await submit(page, page.getByRole("button", { name: "Add division" }), "POST", "/divisions");
  const payload = (await response.json()) as { division?: { id?: string }; id?: string };
  const id = payload.division?.id ?? payload.id;
  if (!id) throw new Error(`Division response omitted id: ${JSON.stringify(payload)}`);
  return id;
}

async function addEightTeams(page: Page) {
  const division = page.getByRole("region", { name: "Championship" });
  for (let index = 1; index <= 8; index += 1) {
    const form = division.locator("form").last();
    await form.getByLabel("Entry name").fill(`V1 Squad ${index}`);
    await form.getByLabel("Seed").fill(String(index));
    await submit(page, form.getByRole("button", { name: "Add entry" }), "POST", "/entries");
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

async function selectableMatchIds(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Issue pass" }).click();
  const ids = await page
    .getByRole("dialog", { name: "Create access pass" })
    .getByLabel("Match")
    .locator("option")
    .evaluateAll((options) =>
      options
        .filter((option) => /V1 Squad \d+.*V1 Squad \d+/u.test(option.textContent ?? ""))
        .map((option) => option.getAttribute("value"))
        .filter((value): value is string => Boolean(value)),
    );
  await page.getByRole("dialog", { name: "Create access pass" }).getByRole("button", { name: "Cancel" }).click();
  return ids;
}

async function scoreAndFinalise(page: Page, accessUrl: string, scorer: string) {
  await page.context().clearCookies({ name: "__Host-matchday-scoring-session" });
  const exchange = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/scoring/access/exchange",
  );
  await page.goto(accessUrl);
  expect((await exchange).status(), "The rendered pass must exchange through the production web BFF").toBe(200);
  await expect(page.getByRole("checkbox", { name: /ready to score this fixture/i })).toBeVisible();
  await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  const goal = page.getByRole("button", { name: /Goal / }).first();
  await goal.click();
  const confirm = page.getByRole("dialog", { name: "Confirm goal" });
  await confirm.getByLabel("Scorer or participant name").fill(scorer);
  await confirm.getByRole("button", { name: /Record goal/ }).click();
  // Canoe Polo has two required periods. Complete the scorer's rendered
  // period-transition control before asking the server to finalise.
  await page.locator("summary").filter({ hasText: "Match actions" }).click();
  await page.getByRole("button", { name: "Period change" }).click();
  const periodChange = page.getByRole("dialog", { name: "Record event: Period change" });
  await periodChange.getByLabel("period").selectOption("2");
  await periodChange.getByLabel("Event time").fill("10:00");
  await periodChange.getByRole("button", { name: "Record event" }).click();
  const finalise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/scoring/finalise",
  );
  await page.getByRole("button", { name: "Review final score" }).click();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  const response = await finalise;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("browser completes an eight-team Canoe group-to-knockout competition", async ({ page, context }, testInfo) => {
  const seed = await state(testInfo.project.name);
  test.setTimeout(600_000);
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

  const slug = `v1-championship-${seed.fixtureKey}`;
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("V1 Eight Team Championship");
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Sport").selectOption("canoe_polo");
  await page.getByLabel("Venue").fill("V1 Championship Arena");
  await page.getByLabel("Address", { exact: true }).fill("8 Matchday Road");
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
  await area.getByLabel("Area name").fill("Championship Court");
  await area.getByLabel("Date").first().fill("2027-08-01");
  await area.getByLabel("Starts", { exact: true }).first().fill("08:00");
  await area.getByLabel("Ends", { exact: true }).first().fill("18:00");
  await area.getByRole("button", { name: "Add window" }).click();
  await area.getByLabel("Date").nth(1).fill("2027-08-02");
  await area.getByLabel("Starts", { exact: true }).nth(1).fill("08:00");
  await area.getByLabel("Ends", { exact: true }).nth(1).fill("18:00");
  await submit(page, page.getByRole("button", { name: "Save capacity" }), "PUT", "/capacity");

  await page.goto(`/organiser/competitions/${competitionId}/entries`);
  const divisionId = await addDivision(page);
  await addEightTeams(page);
  await expect(page.getByText("8 / 16").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/format`);
  await submit(page, page.getByRole("button", { name: "Show format options" }), "POST", "/v1-format-recommendations");
  const championship = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Championship focus" }) });
  // Two complete four-team groups (12 fixtures) feed two semi-finals, a final
  // and a bronze match. The capacity-valid Championship focus card therefore
  // has 16 fixtures, while every entrant is still guaranteed three group games.
  await expect(championship).toContainText("16 matches");
  await submit(page, championship.getByRole("button", { name: "Use this format" }), "POST", "/apply");
  await expect(page.getByTestId("v1-format-selected")).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  await submit(page, page.getByRole("button", { name: "Generate balanced schedule" }), "POST", "/schedule/jobs");
  await expect(page.getByRole("button", { name: "Use schedule" })).toBeVisible({ timeout: 60_000 });
  await submit(page, page.getByRole("button", { name: "Use schedule" }), "POST", "/accept");
  await submit(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const groupMatchIds = await selectableMatchIds(page);
  expect(groupMatchIds).toHaveLength(12);

  for (const [index, matchId] of groupMatchIds.entries()) {
    await page.goto(`/organiser/competitions/${competitionId}/access`);
    await scoreAndFinalise(page, await issuePass(page, matchId), `V1 group scorer ${index + 1}`);
  }

  await page.goto(`/organiser/competitions/${competitionId}/results`);
  await expect(page.getByRole("heading", { name: "Calculated tables" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Advancement decisions" })).toBeVisible();
  // The capacity-valid championship recommendation is a single eight-team group,
  // so there is one authoritative table before its automatic knockout rounds.
  await expect(page.getByRole("region", { name: /standings table/i })).toHaveCount(1);

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const semiFinalIds = (await selectableMatchIds(page)).filter((id) => !groupMatchIds.includes(id));
  expect(semiFinalIds, "Both automatic semi-finals must be exposed after all group results").toHaveLength(2);
  for (const [index, matchId] of semiFinalIds.entries()) {
    await page.goto(`/organiser/competitions/${competitionId}/access`);
    await scoreAndFinalise(page, await issuePass(page, matchId), `V1 semi-final scorer ${index + 1}`);
  }
  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const finalRoundIds = (await selectableMatchIds(page)).filter(
    (id) => ![...groupMatchIds, ...semiFinalIds].includes(id),
  );
  expect(finalRoundIds, "Final and bronze participants must resolve from both semi-final results").toHaveLength(2);
  for (const [index, matchId] of finalRoundIds.entries()) {
    await page.goto(`/organiser/competitions/${competitionId}/access`);
    await scoreAndFinalise(page, await issuePass(page, matchId), index === 0 ? "V1 final scorer" : "V1 bronze scorer");
  }
  const progressedMatchIds = [...semiFinalIds, ...finalRoundIds];

  // The organiser shell refreshes its conflict panel after finalisation. Let
  // that same-origin read settle before changing routes so an intentional test
  // navigation cannot manufacture a browser-level request-abort failure.
  await page.waitForTimeout(300);
  await page.goto(`/competitions/${slug}`);
  await expect(page.getByRole("heading", { name: "V1 Eight Team Championship" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Table" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bracket" })).toBeVisible();
  await expect(page.getByText("V1 Squad 1").first()).toBeVisible();
  expect(failedResponses).toEqual([]);

  const resultFile = process.env.PHASE4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("PHASE4_E2E_RESULT_FILE is required");
  await appendFile(
    resultFile,
    `${JSON.stringify({ project: testInfo.project.name, competitionId, slug, divisionId, groupMatchIds, progressedMatchIds } satisfies JourneyReceipt)}\n`,
    { mode: 0o600 },
  );
});
