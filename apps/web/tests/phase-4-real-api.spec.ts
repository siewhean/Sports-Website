import { appendFile, readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
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
  moved: {
    match_id: string;
    playing_area_id: string;
    slot_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
};

async function state(projectName: string): Promise<State> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, State> };
  const fixture = parsed.projects[projectName];
  if (!fixture) throw new Error(`No real Phase 4 fixture exists for ${projectName}`);
  return fixture;
}

async function submitAndWait(page: Page, button: Locator, method: string, suffix: string) {
  const response = page.waitForResponse(
    (candidate) => candidate.request().method() === method && new URL(candidate.url()).pathname.endsWith(suffix),
  );
  await button.click();
  const received = await response;
  if (received.status() >= 400) {
    throw new Error(`${method} ${suffix} returned ${received.status()}: ${await received.text()}`);
  }
  return received;
}

async function createDivision(page: Page, name: string, code: string): Promise<string> {
  await page.getByLabel("Division name").fill(name);
  await page.getByLabel("Division code").fill(code);
  const response = await submitAndWait(page, page.getByRole("button", { name: "Add division" }), "POST", "/divisions");
  const payload = (await response.json()) as { division?: { id?: string }; id?: string };
  const id = payload.division?.id ?? payload.id;
  if (!id) throw new Error(`Division creation response omitted id: ${JSON.stringify(payload)}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return id;
}

async function addEntries(page: Page, divisionName: string, prefix: string) {
  const division = page.getByRole("region", { name: divisionName });
  for (let seed = 1; seed <= 8; seed += 1) {
    await division.getByLabel("Entry name").fill(`${prefix} ${seed}`);
    await division.getByLabel("Seed").fill(String(seed));
    await submitAndWait(page, division.getByRole("button", { name: "Add entry" }), "POST", "/entries");
  }
}

async function publishDivisionFormat(page: Page, competitionId: string, divisionId: string, label: string) {
  await page.goto(`/organiser/competitions/${competitionId}/format?division=${divisionId}`);
  await expect(page.getByTestId("phase4-format-designer")).toBeVisible();
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  const stageName = page.getByLabel("Stage name").first();
  await stageName.fill(label);
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  await expect(page.getByTestId("format-canvas").getByText(label, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await expect(stageName).toHaveValue(label);
  await page.getByRole("button", { name: "Validate graph" }).click();
  await expect(page.getByText(/Format valid\. \d+ matches can be materialised\./)).toBeVisible();
  await submitAndWait(page, page.getByRole("button", { name: "Save", exact: true }), "PUT", "/format-builder");
  await expect(page.getByText(/Draft revision \d+ saved\./)).toBeVisible();
  await submitAndWait(page, page.getByRole("button", { name: "Materialise" }), "POST", "/materialise");
  await expect(page.getByText(/materialised/i)).toBeVisible();
  await submitAndWait(page, page.getByRole("button", { name: "Publish format" }), "POST", "/publish");
  await expect(page.getByText("Format published. It is now available to deterministic scheduling.")).toBeVisible();
}

async function generateObjective(page: Page, objective: "Fastest" | "Balanced" | "Rest-focused") {
  const objectiveValue = {
    Fastest: "fastest",
    Balanced: "balanced",
    "Rest-focused": "rest_focused",
  }[objective];
  await page.getByRole("radio", { name: objective, exact: true }).click();
  const generateButton = page.getByRole("button", { name: `Generate ${objective}`, exact: true }).first();
  await expect(generateButton).toBeVisible();
  const response = await submitAndWait(page, generateButton, "POST", "/schedule/jobs");
  expect(response.request().postDataJSON()).toMatchObject({ objective: objectiveValue });
  const envelope = (await response.json()) as { job?: { id?: string } };
  const jobId = envelope.job?.id;
  if (!jobId) throw new Error(`Schedule generation response omitted job id: ${JSON.stringify(envelope)}`);
  let lastJob: unknown = null;
  await expect
    .poll(
      async () => {
        const jobResponse = await page.request.get(`/api/phase4/schedule/jobs/${jobId}`);
        lastJob = await jobResponse.json();
        const job = lastJob as {
          status?: string;
          current_best?: unknown;
          failure_class?: string | null;
          explored_candidates?: number;
        };
        if (job.current_best) return "ready";
        if (["failed", "no_solution", "stale", "cancelled"].includes(job.status ?? "")) {
          throw new Error(`Schedule job ended without an option: ${JSON.stringify(job)}`);
        }
        return `${job.status ?? "unknown"}:${job.explored_candidates ?? 0}`;
      },
      { timeout: 60_000, intervals: [500, 1_000, 1_500] },
    )
    .toBe("ready");
  await expect(
    page.getByRole("button", { name: `Use ${objective}`, exact: true }).first(),
    `Schedule option was not rendered after job became ready: ${JSON.stringify(lastJob)}`,
  ).toBeVisible({ timeout: 5_000 });
}

async function selectValidMoveSlot(page: Page, initialResponse: Awaited<ReturnType<Page["waitForResponse"]>>) {
  const confirm = page.getByRole("button", { name: "Confirm move" });
  const readValidation = async (response: Awaited<ReturnType<Page["waitForResponse"]>>) => {
    const payload = (await response.json()) as { validation?: { valid?: boolean } };
    return payload.validation?.valid === true;
  };
  if (await readValidation(initialResponse)) {
    await expect(confirm).toBeEnabled();
    return;
  }

  const showAll = page.getByRole("button", { name: /Show all \d+ times/ });
  if (await showAll.isVisible()) await showAll.click();
  const choices = page.getByTestId("move-slot-choices").locator('input[type="radio"]:not([disabled])');
  const count = await choices.count();
  for (let index = 0; index < count; index += 1) {
    const choice = choices.nth(index);
    if (await choice.isChecked()) continue;
    const validationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/moves/validate"),
    );
    await choice.check();
    if (await readValidation(await validationResponse)) {
      await expect(confirm).toBeEnabled();
      return;
    }
  }
  throw new Error("No server-validated move slot was available in the rendered mobile-semantic choices");
}

test.afterEach(async ({ page }, testInfo) => {
  await assertConsoleGuard(page, testInfo);
});

test("browser owns the complete Gate B organiser journey", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
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

  const slug = `browser-owned-${seed.fixtureKey}`;
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(seed.organisationId);
  await page.getByLabel("Competition name").fill("Phase 4 Browser Verified Cup");
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Sport").selectOption("canoe_polo");
  await page.getByLabel("Venue").fill("Real E2E Arena");
  await page.getByLabel("Address", { exact: true }).fill("4 Integration Road");
  await page.getByLabel("Locality").fill("Singapore");
  await page.getByLabel("Country code").fill("SG");
  await page.getByLabel("Start date").fill("2027-08-01");
  await page.getByLabel("End date").fill("2027-08-02");
  await page.getByLabel("Time zone").fill("Asia/Singapore");
  await page.getByLabel("Locale").fill("en-SG");
  await submitAndWait(
    page,
    page.getByRole("button", { name: "Create competition" }),
    "POST",
    "/api/phase3/competitions",
  );
  await page.waitForURL(/\/organiser\/competitions\/[0-9a-f-]+\/setup$/);
  const competitionId = /\/competitions\/([0-9a-f-]+)\//.exec(page.url())?.[1];
  if (!competitionId) throw new Error(`Could not read created competition id from ${page.url()}`);
  await expect(page.getByRole("button", { name: "Start setup" })).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/settings`);
  const settings = page.getByTestId("phase3-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Canoe Polo", exact: true })).toBeVisible();
  await expect(settings.locator("dt").filter({ hasText: "Pack version" })).toBeVisible();

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
  await page.getByRole("button", { name: "Add playing area" }).click();
  const secondArea = page.locator("fieldset").nth(1);
  await secondArea.getByLabel("Area name").fill("Court 2");
  await secondArea.getByLabel("Date").first().fill("2027-08-01");
  await secondArea.getByLabel("Starts", { exact: true }).first().fill("08:00");
  await secondArea.getByLabel("Ends", { exact: true }).first().fill("18:00");
  await secondArea.getByRole("button", { name: "Add window" }).click();
  await secondArea.getByLabel("Date").nth(1).fill("2027-08-02");
  await secondArea.getByLabel("Starts", { exact: true }).nth(1).fill("08:00");
  await secondArea.getByLabel("Ends", { exact: true }).nth(1).fill("18:00");
  await submitAndWait(page, page.getByRole("button", { name: "Save capacity" }), "PUT", "/capacity");
  await expect(page.getByText("Saved").first()).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/entries`);
  const openId = await createDivision(page, "Open", "OPEN");
  const womenId = await createDivision(page, "Women", "WOMEN");
  await addEntries(page, "Open", "Open Team");
  await addEntries(page, "Women", "Women Team");
  await expect(page.getByText("16 / 16").first()).toBeVisible();
  const rejected = page.getByRole("region", { name: "Open" });
  await rejected.getByLabel("Entry name").fill("Rejected Team 17");
  await rejected.getByLabel("Seed").fill("9");
  allowConsoleFailure(
    page,
    /^console\.error: Failed to load resource: the server responded with a status of 422 \(Unprocessable (?:Content|Entity)\)$/,
  );
  const limitResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/entries"),
  );
  await rejected.getByRole("button", { name: "Add entry" }).click();
  expect((await limitResponse).status()).toBe(422);
  await expect(page.getByText("Free plan permits at most 16 active entries across all divisions.")).toBeVisible();

  await page.goto(`/organiser/competitions/${competitionId}/setup`);
  await page.getByRole("button", { name: "Start setup" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expect(page.getByLabel("Competition name")).toHaveValue("Phase 4 Browser Verified Cup");
  await expect(page.getByLabel("Sport")).toHaveValue("canoe_polo");
  for (const next of [
    { label: "capacity", step: "capacity" },
    { label: "settings", step: "settings" },
    { label: "entries", step: "entries" },
    { label: "preferences", step: "format_preferences" },
  ] as const) {
    const continueButton = page.getByRole("button", { name: new RegExp(`Continue to ${next.label}`, "i") });
    await expect(continueButton).toBeVisible({ timeout: 15_000 });
    const mutation = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url().endsWith("/setup-draft"),
    );
    await continueButton.click();
    const response = await mutation;
    const payload = (await response.json()) as {
      outcome?: string;
      document?: { current_step?: string };
      current?: { current_step?: string };
    };
    expect(response.status(), `Setup transition to ${next.step}: ${JSON.stringify(payload)}`).toBe(200);
    expect(payload.outcome, `Setup transition to ${next.step}: ${JSON.stringify(payload)}`).toBe("saved");
    expect(payload.document?.current_step, `Setup transition to ${next.step}: ${JSON.stringify(payload)}`).toBe(
      next.step,
    );
  }
  await page.getByLabel("Minimum matches per entry").fill("2");
  await page.getByRole("radio", { name: /Participation/ }).check();
  const recommendationMutation = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/setup-draft"),
  );
  await page.getByRole("button", { name: /Continue to recommendations/i }).click();
  const recommendationResponse = await recommendationMutation;
  const recommendationPayload = (await recommendationResponse.json()) as {
    outcome?: string;
    document?: {
      current_step?: string;
      values?: { format_recommendations?: { recommendations?: unknown[]; requires_changes?: unknown } | null };
    };
  };
  expect(recommendationResponse.status(), `Recommendation transition: ${JSON.stringify(recommendationPayload)}`).toBe(
    200,
  );
  expect(recommendationPayload.outcome, `Recommendation transition: ${JSON.stringify(recommendationPayload)}`).toBe(
    "saved",
  );
  expect(
    recommendationPayload.document?.current_step,
    `Recommendation transition: ${JSON.stringify(recommendationPayload)}`,
  ).toBe("format_recommendations");
  expect(
    (recommendationPayload.document?.values?.format_recommendations?.recommendations?.length ?? 0) +
      (recommendationPayload.document?.values?.format_recommendations?.requires_changes ? 1 : 0),
    `Recommendation transition: ${JSON.stringify(recommendationPayload)}`,
  ).toBeGreaterThan(0);
  const recommendation = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Championship focus" }) })
    .getByRole("button", { name: "Select format" });
  await expect(recommendation).toBeEnabled();
  const selectionMutation = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/setup-draft"),
  );
  await recommendation.click();
  const selectionResponse = await selectionMutation;
  const selectionPayload = (await selectionResponse.json()) as {
    outcome?: string;
    document?: {
      current_step?: string;
      values?: { format_recommendations?: { selected_recommendation_id?: string | null } | null };
    };
  };
  expect(selectionResponse.status(), `Format selection: ${JSON.stringify(selectionPayload)}`).toBe(200);
  expect(
    selectionPayload.document?.values?.format_recommendations?.selected_recommendation_id,
    `Format selection: ${JSON.stringify(selectionPayload)}`,
  ).toEqual(expect.any(String));
  expect(selectionPayload.document?.current_step, `Format selection: ${JSON.stringify(selectionPayload)}`).toBe(
    "schedule_review",
  );

  await publishDivisionFormat(page, competitionId, openId, "Browser Open stage");
  await publishDivisionFormat(page, competitionId, womenId, "Browser Women stage");

  const unpublished = await context.request.get(`${seed.webOrigin}/competitions/${slug}`);
  expect(unpublished.status(), "Private schedule work must not be public").toBe(404);

  await page.goto(`/organiser/competitions/${competitionId}/schedule`);
  await generateObjective(page, "Fastest");
  await generateObjective(page, "Balanced");
  await generateObjective(page, "Rest-focused");
  await expect(page.getByRole("button", { name: "Use Fastest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Balanced" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Rest-focused" })).toBeVisible();
  await submitAndWait(page, page.getByRole("button", { name: "Use Balanced" }), "POST", "/accept");

  const matchButtons = page.locator("button[aria-pressed]").filter({ visible: true });
  await matchButtons.first().click();
  await submitAndWait(page, page.getByRole("button", { name: "Lock match" }), "POST", "/locks");
  await expect(page.getByRole("button", { name: "Unlock match" })).toBeVisible();
  const movableMatch = page
    .locator('button[aria-pressed][aria-label^="championship-r2-m1,"]')
    .filter({ visible: true })
    .first();
  const initialMoveValidation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/moves/validate"),
  );
  await movableMatch.click();
  await expect(movableMatch).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "championship-r2-m1" })).toBeVisible();
  await page.getByRole("link", { name: "Move" }).click();
  await expect(page.getByTestId("phase4-move-flow")).toBeVisible();
  await selectValidMoveSlot(page, await initialMoveValidation);
  const moveRequest = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/moves"),
  );
  await page.getByRole("button", { name: "Confirm move" }).click();
  const moved = (await moveRequest).postDataJSON() as JourneyResult["moved"];
  await page.waitForURL(new RegExp(`/organiser/competitions/${competitionId}/schedule`));
  await page.getByRole("link", { name: "Compare revisions" }).click();
  await expect(page.getByRole("heading", { name: /Compare revisions/i })).toBeVisible();
  await page.goBack();
  await submitAndWait(page, page.getByRole("button", { name: "Publish schedule" }), "POST", "/publish");

  await page.goto(`/organiser/competitions/${competitionId}/setup`);
  const reviewMutation = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/setup-draft"),
  );
  await page.getByRole("button", { name: /Continue to review/i }).click();
  const reviewResponse = await reviewMutation;
  const reviewPayload = (await reviewResponse.json()) as {
    outcome?: string;
    document?: { current_step?: string };
  };
  expect(reviewResponse.status(), `Review transition: ${JSON.stringify(reviewPayload)}`).toBe(200);
  expect(reviewPayload.outcome, `Review transition: ${JSON.stringify(reviewPayload)}`).toBe("saved");
  expect(reviewPayload.document?.current_step, `Review transition: ${JSON.stringify(reviewPayload)}`).toBe(
    "review_publish",
  );
  const completionMutation = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/setup-draft") &&
      response.request().postData()?.includes('"kind":"complete"') === true,
  );
  await page.getByRole("button", { name: "Publish competition" }).click();
  const completionResponse = await completionMutation;
  const completionPayload = (await completionResponse.json()) as {
    outcome?: string;
    document?: { status?: string };
  };
  expect(completionResponse.status(), `Setup completion: ${JSON.stringify(completionPayload)}`).toBe(200);
  expect(completionPayload.outcome, `Setup completion: ${JSON.stringify(completionPayload)}`).toBe("saved");
  expect(completionPayload.document?.status, `Setup completion: ${JSON.stringify(completionPayload)}`).toBe(
    "completed",
  );
  await page.reload();
  await expect(page.getByText("This setup is read only").first()).toBeVisible();

  await page.goto(`/competitions/${slug}`);
  await expect(page.getByRole("heading", { name: "Phase 4 Browser Verified Cup" })).toBeVisible();
  const publicTime = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(moved.start_epoch_ms);
  const publicMovedMatch = page.locator(`.p2-public-fixtures > li[data-match-id="${moved.match_id}"]`);
  await expect(publicMovedMatch).toHaveCount(1);
  await expect(publicMovedMatch.getByText(publicTime, { exact: true })).toBeVisible();

  const resultFile = process.env.PHASE4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("PHASE4_E2E_RESULT_FILE is required");
  const result: JourneyResult = {
    project: testInfo.project.name,
    competitionId,
    slug,
    divisionIds: [openId, womenId],
    moved,
  };
  await appendFile(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  expect(failedResponses).toEqual([
    `422 POST ${seed.webOrigin}/api/phase3/competitions/${competitionId}/divisions/${openId}/entries`,
  ]);
});
