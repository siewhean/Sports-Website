import { readFile } from "node:fs/promises";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type SeedState = {
  apiOrigin: string;
  webOrigin: string;
  competitionId: string;
  matchId: string;
  slug: string;
  homeName: string;
  awayName: string;
  accessToken: string;
  organiserCookie: string;
  csrfToken: string;
};

async function seedState(): Promise<SeedState> {
  const file = process.env.PHASE2_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE2_E2E_STATE_FILE is required");
  return JSON.parse(await readFile(file, "utf8")) as SeedState;
}

test("real phone scoring recovers, publishes, and preserves correction versions", async ({
  page,
  context,
}, testInfo) => {
  const state = await seedState();
  await installConsoleGuard(page);
  const failedResponses: string[] = [];
  const scoringResponses: string[] = [];
  const scoringRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/scoring/")) scoringRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    if (response.url().includes("/api/scoring/")) scoringResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`/score#access=${encodeURIComponent(state.accessToken)}`);
  await dismissConsent(page);
  await expect(page).toHaveURL(`${state.webOrigin}/score`);
  await expect(
    page.getByRole("heading", { name: `${state.homeName} vs ${state.awayName}` }),
    `${await page.locator("body").innerText()}\n${failedResponses.join("\n")}\n${scoringRequests.join("\n")}\n${scoringResponses.join("\n")}`,
  ).toBeVisible({ timeout: 15_000 });

  const browserStorage = await page.evaluate(() => ({
    cookie: document.cookie,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(browserStorage)).not.toContain(state.accessToken);
  expect(browserStorage.session).toEqual([]);
  const scoringCookies = (await context.cookies()).filter(
    (cookie) => cookie.name === "__Host-matchday-scoring-session",
  );
  expect(scoringCookies, "BFF must retain scoring credentials only in an HttpOnly scoped cookie").toHaveLength(1);
  expect(scoringCookies[0]).toMatchObject({
    name: "__Host-matchday-scoring-session",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  expect(browserStorage.cookie).not.toContain(scoringCookies[0]?.name ?? "__missing_scoring_cookie__");

  await page.getByRole("checkbox", { name: /ready to score this fixture/i }).check();
  await page.getByRole("button", { name: "Start scoring" }).click();
  await page.getByRole("button", { name: `Goal ${state.homeName}` }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm goal" });
  await confirmation.getByLabel("Scorer name").fill("Aisha Tan");
  await confirmation.getByRole("button", { name: `Record goal for ${state.homeName}` }).click();
  await expect(page.getByLabel(`${state.homeName} 1`)).toBeVisible();
  await expect(page.locator(".p2-event-log")).toContainText("Scorer: Aisha Tan");

  await page.reload();
  await expect(page.locator(".p2-writer")).toContainText("Active scorer");
  await expect(page.getByLabel(`${state.homeName} 1`)).toBeVisible();
  await expect(page.locator(".p2-event-log")).toContainText("Scorer: Aisha Tan");
  const recoveredStorage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(recoveredStorage)).not.toContain(state.accessToken);
  expect(recoveredStorage.session).toEqual([]);
  expect(recoveredStorage.local.map(([key]) => key)).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/scoring|session|token|auth/i)]),
  );

  await page.getByRole("button", { name: "Review final score" }).click();
  await expect(page.getByRole("heading", { name: `${state.homeName} 1–0 ${state.awayName}` })).toBeVisible();
  await page.getByRole("button", { name: "Confirm final result" }).click();
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
  await expect(page.getByText(`${state.matchId}:v1`, { exact: false })).toBeVisible();

  await page.getByRole("link", { name: "Open public page" }).click();
  await expect(page).toHaveURL(`${state.webOrigin}/competitions/${state.slug}`);
  await expect(page.getByRole("heading", { name: "Phase 2 Real E2E Cup" })).toBeVisible();
  const publicResult = page.locator(".p2-public-score--final");
  await expect(publicResult).toContainText(state.homeName);
  await expect(publicResult).toContainText(state.awayName);
  await expect(
    publicResult.locator("div").filter({ hasText: state.homeName }).getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    publicResult.locator("div").filter({ hasText: state.awayName }).getByText("0", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/sch_1 · res_1/).first()).toBeVisible();

  const organiser = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: {
      cookie: state.organiserCookie,
      origin: state.webOrigin,
      "x-csrf-token": state.csrfToken,
    },
  });
  try {
    const correction = await organiser.post(
      `/api/v1/competitions/${state.competitionId}/matches/${state.matchId}/corrections`,
      {
        data: {
          client_event_id: crypto.randomUUID(),
          reason: "Official score sheet correction",
          home_score: 1,
          away_score: 1,
        },
      },
    );
    expect(correction.status(), await correction.text()).toBe(200);
    expect(await correction.json()).toMatchObject({ match_id: state.matchId, result_version: 2 });
    const publicProjection = await organiser.get(`/api/v1/public/competitions/${state.slug}`);
    expect(publicProjection.status(), await publicProjection.text()).toBe(200);
    const projection = (await publicProjection.json()) as {
      publication: { schedule_version: number; result_version: number };
      results: Array<{ id: string; home_score: number; away_score: number; state: string }>;
    };
    expect(projection.publication).toEqual({ schedule_version: 1, result_version: 2 });
    expect(projection.results.find((result) => result.id === state.matchId)).toMatchObject({
      home_score: 1,
      away_score: 1,
      state: "corrected",
    });
  } finally {
    await organiser.dispose();
  }

  await page.reload();
  await expect(
    publicResult.locator("div").filter({ hasText: state.homeName }).getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    publicResult.locator("div").filter({ hasText: state.awayName }).getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/sch_1 · res_2/).first()).toBeVisible();
  await assertConsoleGuard(page, testInfo);
});
