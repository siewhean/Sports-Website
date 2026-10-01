import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type RealState = {
  apiOrigin: string;
  competitionSlug: string;
  publicCompetitionPath: string;
  divisionNames: string[];
};

async function readState(): Promise<RealState> {
  const filename = process.env.PHASE7_E2E_STATE_FILE;
  if (!filename) throw new Error("PHASE7_E2E_STATE_FILE is required for real-stack acceptance");
  const state = JSON.parse(await readFile(filename, "utf8")) as RealState;
  if (!state.apiOrigin || !state.competitionSlug || !state.publicCompetitionPath || !state.divisionNames?.length) {
    throw new Error("Real-stack fixture must include published competition identity and divisions");
  }
  // This test creates disposable games; never run its mutations against a hosted deployment.
  for (const origin of [state.apiOrigin, process.env.PHASE7_E2E_WEB_BASE_URL ?? ""]) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) {
      throw new Error("Casual/public lifecycle acceptance requires an isolated loopback fixture");
    }
  }
  return state;
}

test("guest creates a real game, host scores, viewer observes, and invalid host token cannot mutate", async ({
  page,
  browser,
}) => {
  await readState();
  await installConsoleGuard(page);
  await page.goto("/play");
  await dismissConsent(page);
  await page.getByLabel("First side").fill("Gate D Home");
  await page.getByLabel("Second side").fill("Gate D Away");
  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/casual/games") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { game: { id: string }; viewer_token: string };
  const id = body.game.id;
  expect(body.viewer_token).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`/play/${id}$`));
  const homePoint = page.getByRole("button", { name: "Add one point for Gate D Home. Current score 0", exact: true });
  await expect(homePoint).toBeVisible();

  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    await installConsoleGuard(viewer);
    await viewer.goto(
      new URL(`/play/${id}/watch?viewer_token=${encodeURIComponent(body.viewer_token)}`, page.url()).href,
    );
    await dismissConsent(viewer);
    const viewerHome = viewer
      .getByRole("region", { name: "Current score" })
      .locator("div")
      .filter({
        has: viewer.getByText("Gate D Home", { exact: true }),
      })
      .last();
    await expect(viewerHome.locator("strong")).toHaveText("0");
    await expect(viewer.getByRole("button", { name: /Add one point/ })).toHaveCount(0);
    await homePoint.click();
    await expect(
      page.getByRole("button", { name: "Add one point for Gate D Home. Current score 1", exact: true }),
    ).toBeVisible();
    await expect(viewerHome.locator("strong")).toHaveText("1", { timeout: 15_000 });

    const readUrl = new URL(
      `/api/v1/casual/games/${id}?viewer_token=${encodeURIComponent(body.viewer_token)}`,
      page.url(),
    ).href;
    const before = await viewerContext.request.get(readUrl);
    expect(before.status()).toBe(200);
    const beforeBody = (await before.json()) as { version: number; home_score: number; away_score: number };
    const denied = await viewerContext.request.post(new URL(`/api/v1/casual/games/${id}/actions`, page.url()).href, {
      headers: { "x-casual-host-token": "invalid-host-token-with-valid-length-000000" },
      data: { side: "home", points: 1 },
    });
    expect(denied.status()).toBe(404);
    expect((await denied.json()).error.code).toBe("NOT_FOUND");
    const after = await viewerContext.request.get(readUrl);
    expect(after.status()).toBe(200);
    const afterBody = (await after.json()) as typeof beforeBody;
    expect(afterBody.version).toBe(beforeBody.version);
    expect(afterBody.home_score).toBe(1);
    expect(afterBody.away_score).toBe(0);
  } finally {
    await viewerContext.close();
  }
});

test("published competition renders without login and serves conditional public ETags", async ({ page, request }) => {
  const state = await readState();
  await installConsoleGuard(page);
  await page.goto(state.publicCompetitionPath);
  await dismissConsent(page);
  await expect(page).toHaveURL(new RegExp(state.publicCompetitionPath));
  for (const division of state.divisionNames)
    await expect(page.getByText(division, { exact: true }).first()).toBeVisible();
  const endpoint = `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`;
  const response = await request.get(endpoint);
  expect(response.status()).toBe(200);
  const etag = response.headers().etag;
  expect(etag).toBeTruthy();
  const conditional = await request.get(endpoint, { headers: { "if-none-match": etag } });
  expect(conditional.status()).toBe(304);
  expect(await conditional.body()).toHaveLength(0);
});
