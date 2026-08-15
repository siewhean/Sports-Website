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

type JourneyReceipt = {
  project: string;
  competitionId: string;
  slug: string;
  divisionId: string;
  groupMatchIds: string[];
  progressedMatchIds: string[];
  completedMatchIds: string[];
  initialStage: "groups" | "championship";
  correctedMatchId: string;
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

async function addSixteenTeams(page: Page) {
  const division = page.getByRole("region", { name: "Championship" });
  for (let index = 1; index <= 16; index += 1) {
    const form = division.locator("form").last();
    await form.getByLabel("Entry name").fill(`V1 Squad ${index}`);
    await form.getByLabel("Seed").fill(String(index));
    await submit(page, form.getByRole("button", { name: "Add entry" }), "POST", "/entries");
  }
}

async function correctOpeningResult(page: Page, competitionId: string, matchId: string) {
  await page.goto(`/organiser/competitions/${competitionId}/results?match=${matchId}`);
  await expect(page.getByRole("heading", { name: "Scoring event history" })).toBeVisible();
  const reopen = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/reopen"),
  );
  await page.getByRole("button", { name: "Reopen for correction" }).click();
  const reopenDialog = page.getByRole("dialog", { name: "Reopen for correction" });
  await reopenDialog.getByLabel("Correction reason").fill("Official knockout score-sheet correction");
  await reopenDialog.getByRole("button", { name: "Reopen match" }).click();
  expect((await reopen).status()).toBe(200);
  await expect(reopenDialog).toBeHidden();

  const correction = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/corrections"),
  );
  await page.getByRole("button", { name: "Reverse scoring event" }).click();
  const correctionDialog = page.getByRole("dialog", { name: "Apply correction and publish result" });
  await correctionDialog.getByLabel("Event to reverse").selectOption({ index: 1 });
  await correctionDialog.getByLabel("Add a replacement of this validated action").check();
  await correctionDialog.getByLabel("Replacement side").selectOption("away");
  const participant = correctionDialog.getByLabel("Replacement participant name");
  if (await participant.count()) await participant.fill("V1 correction scorer");
  await correctionDialog.getByLabel("Correction reason").fill("Official knockout score-sheet correction");
  await correctionDialog.getByRole("button", { name: "Publish correction" }).click();
  const correctionResponse = await correction;
  expect(correctionResponse.status(), await correctionResponse.text()).toBe(200);
  await expect(correctionDialog).toBeHidden();
  await expect(page.getByText("Correction finalised and the corrected result published.", { exact: true })).toBeVisible();
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

type SelectableMatch = Readonly<{ id: string; label: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function dependentMatchId(
  page: Page,
  seed: State,
  competitionId: string,
  sourceMatchId: string,
): Promise<string> {
  const response = await page.request.get(
    `${seed.apiOrigin}/api/v1/competitions/${encodeURIComponent(competitionId)}/schedule-workspace`,
    { headers: { cookie: seed.organiserCookie } },
  );
  expect(response.status(), await response.text()).toBe(200);
  const payload = record(await response.json());
  const matches = Array.isArray(payload?.matches) ? payload.matches.map(record).filter(Boolean) : [];
  const dependent = matches.find(
    (match) =>
      typeof match?.id === "string" &&
      Array.isArray(match.dependency_match_ids) &&
      match.dependency_match_ids.includes(sourceMatchId),
  );
  if (!dependent || typeof dependent.id !== "string") {
    throw new Error(`Expected a scheduled downstream match for ${sourceMatchId}`);
  }
  return dependent.id;
}

async function selectableMatches(page: Page): Promise<SelectableMatch[]> {
  await page.getByRole("button", { name: "Issue pass" }).click();
  const matches = await page
    .getByRole("dialog", { name: "Create access pass" })
    .getByLabel("Match")
    .locator("option")
    .evaluateAll((options) =>
      options
        .filter((option) => /V1 Squad \d+.*V1 Squad \d+/u.test(option.textContent ?? ""))
        .flatMap((option) => {
          const id = option.getAttribute("value");
          const label = option.textContent?.trim() ?? "";
          return id ? [{ id, label }] : [];
        }),
    );
  await page.getByRole("dialog", { name: "Create access pass" }).getByRole("button", { name: "Cancel" }).click();
  return matches;
}

async function selectableMatchIds(page: Page): Promise<string[]> {
  return (await selectableMatches(page)).map((match) => match.id);
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
  await page.locator("summary").filter({ hasText: "Match actions" }).click();
  await page.getByRole("button", { name: "Period change" }).click();
  const periodChange = page.getByRole("dialog", { name: "Record event: Period change" });
  await periodChange.getByLabel("period").selectOption("2");
  await periodChange.getByLabel("Event time").fill("10:00");
  await periodChange.getByRole("button", { name: "Record event" }).click();
  const finalise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/scoring/finalise",
  );
  await page.getByRole("button", { name: "Review final score" }).click();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  const response = await finalise;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("browser completes and corrects a sixteen-team Canoe compact knockout", async ({ page, context }, testInfo) => {
  const seed = await state(testInfo.project.name);
  test.setTimeout(600_000);
  await installConsoleGuard(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([{ name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" }]);

  const slug = `v1-championship-${seed.fixtureKey}`;
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("V1 Sixteen Team Knockout");
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
  await addSixteenTeams(page);
  await expect(page.getByText("16 / 16").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/format`);
  await submit(page, page.getByRole("button", { name: "Show format options" }), "POST", "/v1-format-recommendations");
  const compact = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Compact knockout" }) });
  await expect(compact).toContainText("16 matches");
  await submit(page, compact.getByRole("button", { name: "Use this format" }), "POST", "/apply");
  await expect(page.getByTestId("v1-format-selected")).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  await submit(page, page.getByRole("button", { name: "Generate balanced schedule" }), "POST", "/schedule/jobs");
  await expect(page.getByRole("button", { name: "Use schedule" })).toBeVisible({ timeout: 60_000 });
  await submit(page, page.getByRole("button", { name: "Use schedule" }), "POST", "/accept");
  await submit(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const openingMatches = await selectableMatches(page);
  const groupMatchIds = openingMatches.map((match) => match.id);
  expect(groupMatchIds).toHaveLength(8);

  for (const [index, matchId] of groupMatchIds.entries()) {
    await page.goto(`/organiser/competitions/${competitionId}/access`);
    await scoreAndFinalise(page, await issuePass(page, matchId), `V1 opening scorer ${index + 1}`);
  }

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const openingWinner = "V1 Squad 1";
  const correctedWinner = "V1 Squad 2";
  const correctedOpeningMatch = openingMatches.find((match) => /\bV1 Squad 1 vs V1 Squad 2\b/u.test(match.label));
  if (!correctedOpeningMatch) throw new Error("Expected the deterministic V1 Squad 1 versus V1 Squad 2 opening match");
  const dependentQuarterFinalId = await dependentMatchId(page, seed, competitionId, correctedOpeningMatch.id);

  await page.goto(`/competitions/${slug}`);
  const publicDependentSchedule = page.locator(`[data-match-id="${dependentQuarterFinalId}"]`).first();
  await expect(publicDependentSchedule).toContainText(openingWinner);
  const publicDependentBracket = page.locator(`.p2-public-bracket article[data-match-id="${dependentQuarterFinalId}"]`);
  await expect(publicDependentBracket).toContainText(openingWinner);

  await correctOpeningResult(page, competitionId, correctedOpeningMatch.id);

  await page.goto(`/organiser/competitions/${competitionId}/access`);
  const correctedDependentQuarterFinal = (await selectableMatches(page)).find((match) => match.id === dependentQuarterFinalId);
  expect(correctedDependentQuarterFinal?.label).toContain(correctedWinner);
  expect(correctedDependentQuarterFinal?.label).not.toContain(openingWinner);

  await page.goto(`/competitions/${slug}`);
  await expect(page.locator(`[data-match-id="${dependentQuarterFinalId}"]`).first()).toContainText(correctedWinner);
  await expect(page.locator(`.p2-public-bracket article[data-match-id="${dependentQuarterFinalId}"]`)).toContainText(correctedWinner);

  await page.goto(`/organiser/competitions/${competitionId}/results`);
  await expect(page.getByRole("heading", { name: "Calculated tables" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Advancement decisions" })).toBeVisible();
  await expect(page.getByRole("region", { name: /standings table/i })).toHaveCount(1);

  const progressedMatchIds: string[] = [];
  for (const expectedRoundSize of [4, 2, 2]) {
    await page.goto(`/organiser/competitions/${competitionId}/access`);
    const round = (await selectableMatchIds(page)).filter(
      (id) => !groupMatchIds.includes(id) && !progressedMatchIds.includes(id),
    );
    expect(round, `Expected ${expectedRoundSize} automatically resolved knockout matches`).toHaveLength(expectedRoundSize);
    for (const [index, matchId] of round.entries()) {
      await page.goto(`/organiser/competitions/${competitionId}/access`);
      await scoreAndFinalise(page, await issuePass(page, matchId), `V1 knockout scorer ${expectedRoundSize}-${index + 1}`);
    }
    progressedMatchIds.push(...round);
  }
  expect(progressedMatchIds).toHaveLength(8);

  await page.waitForTimeout(300);
  await page.goto(`/organiser/competitions/${competitionId}/results`);
  const completedProgress = page.locator("section").filter({ has: page.getByRole("heading", { name: "Results" }) }).first();
  await expect(completedProgress).toContainText("16 / 16");

  await page.goto(`/organiser/competitions/${competitionId}/publish`);
  await expect(page.getByRole("button", { name: /create revision/i })).toHaveCount(0);
  await expect(page.locator(`a[href="/competitions/${slug}"]`)).toBeVisible();

  await page.goto(`/competitions/${slug}`);
  await expect(page.getByRole("heading", { name: "V1 Sixteen Team Knockout" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Table" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bracket" })).toBeVisible();
  await expect(page.getByText("V1 Squad 1").first()).toBeVisible();
  expect(failedResponses).toEqual([]);

  const resultFile = process.env.PHASE4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("PHASE4_E2E_RESULT_FILE is required");
  await appendFile(
    resultFile,
    `${JSON.stringify({
      project: testInfo.project.name,
      competitionId,
      slug,
      divisionId,
      groupMatchIds,
      progressedMatchIds,
      completedMatchIds: [...groupMatchIds, ...progressedMatchIds],
      initialStage: "championship",
      correctedMatchId: correctedOpeningMatch.id,
    } satisfies JourneyReceipt)}\n`,
    { mode: 0o600 },
  );
});
