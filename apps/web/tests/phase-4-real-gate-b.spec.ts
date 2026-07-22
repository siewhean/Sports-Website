import { readFile } from "node:fs/promises";
import { expect, request as playwrightRequest, test, type BrowserContext, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type GateBRealState = Readonly<{
  apiOrigin: string;
  webOrigin: string;
  recommendationCompetitionId: string;
  acceptedCompetitionId: string;
  completedCompetitionId: string;
  completedSlug: string;
  recommendationName: string;
  recommendationRevision: number;
  acceptedRevision: number;
  acceptedScheduleRevisionId: string;
  completedRevision: number;
  completedScheduleRevisionId: string;
  organiserCookieName: string;
  organiserCookieValue: string;
  outsiderCookieName: string;
  outsiderCookieValue: string;
  csrfToken: string;
}>;

async function readState(): Promise<GateBRealState> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  return JSON.parse(await readFile(file, "utf8")) as GateBRealState;
}

async function authenticate(context: BrowserContext, state: GateBRealState): Promise<void> {
  await context.addCookies([
    {
      name: state.organiserCookieName,
      value: state.organiserCookieValue,
      url: state.webOrigin,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    },
  ]);
}

function trackFailedApplicationResponses(page: Page): string[] {
  const failures: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && (url.includes("/api/") || url.includes("/organiser/"))) {
      failures.push(`${response.status()} ${url}`);
    }
  });
  return failures;
}

function organiserHeaders(state: GateBRealState) {
  return { cookie: `${state.organiserCookieName}=${state.organiserCookieValue}` };
}

async function apiDocument(state: GateBRealState, competitionId: string) {
  const context = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: organiserHeaders(state),
  });
  try {
    const response = await context.get(`/api/v1/competitions/${competitionId}/setup-draft`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as {
      revision: number;
      status: string;
      current_step: string;
      permission: string;
      read_only: boolean;
      values: {
        format_recommendations: { selected_recommendation_id: string | null; recommendations: unknown[] } | null;
        schedule_review: { schedule_revision_id: string } | null;
        review_publish: { published_schedule_revision_id: string | null } | null;
      };
    };
  } finally {
    await context.dispose();
  }
}

async function apiScheduleRevision(state: GateBRealState, revisionId: string) {
  const context = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: organiserHeaders(state),
  });
  try {
    const response = await context.get(`/api/v1/schedule-revisions/${revisionId}`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as { id: string; revision: number; status: string; assignment_hash: string | null };
  } finally {
    await context.dispose();
  }
}

test.beforeEach(async ({ page, context }) => {
  const state = await readState();
  await authenticate(context, state);
  await installConsoleGuard(page);
});

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("unselected canonical recommendations survive authenticated resume and reload", async ({ page }) => {
  const state = await readState();
  const failures = trackFailedApplicationResponses(page);
  await page.goto(`/organiser/competitions/${encodeURIComponent(state.recommendationCompetitionId)}/setup`);
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  const recommendation = page.locator("article").filter({ hasText: state.recommendationName });
  await expect(recommendation).toBeVisible({ timeout: 15_000 });
  await expect(recommendation.getByRole("button")).toBeEnabled();
  await page.reload();
  await expect(page.locator("article").filter({ hasText: state.recommendationName })).toBeVisible({ timeout: 15_000 });
  const document = await apiDocument(state, state.recommendationCompetitionId);
  expect(document).toMatchObject({
    revision: state.recommendationRevision,
    status: "active",
    current_step: "format_recommendations",
    permission: "write",
    read_only: false,
  });
  expect(document.values.format_recommendations?.selected_recommendation_id).toBeNull();
  expect(document.values.format_recommendations?.recommendations.length).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test("accepted schedule survives resume, lock overlay, and organiser publication", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Mutating fixture is isolated to one browser project");
  const state = await readState();
  const failures = trackFailedApplicationResponses(page);
  await page.goto(`/organiser/competitions/${encodeURIComponent(state.acceptedCompetitionId)}/setup`);
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  const document = await apiDocument(state, state.acceptedCompetitionId);
  expect(document).toMatchObject({
    revision: state.acceptedRevision,
    status: "active",
    current_step: "review_publish",
    permission: "write",
    read_only: false,
  });
  expect(document.values.schedule_review?.schedule_revision_id).toBe(state.acceptedScheduleRevisionId);

  await page.goto(`/organiser/competitions/${encodeURIComponent(state.acceptedCompetitionId)}/schedule`);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  const lock = page.getByRole("button", { name: /^Lock$/i });
  await expect(lock).toBeVisible();
  await expect(lock).toBeEnabled();
  await lock.click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /^Unlock$/i })).toBeVisible();

  const publish = page.getByRole("button", { name: /^Publish$/i });
  await expect(publish).toBeVisible();
  await expect(publish).toBeEnabled();
  await publish.click();
  await page.waitForLoadState("networkidle");

  const revision = await apiScheduleRevision(state, state.acceptedScheduleRevisionId);
  expect(revision).toMatchObject({ id: state.acceptedScheduleRevisionId, status: "published" });
  expect(revision.assignment_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(failures).toEqual([]);
});

test("published completed setup reloads read-only and public projection stays published", async ({ page, context }) => {
  const state = await readState();
  const failures = trackFailedApplicationResponses(page);
  await page.goto(`/organiser/competitions/${encodeURIComponent(state.completedCompetitionId)}/setup`);
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /read.?only/i })).toBeVisible();
  await expect(page.getByTestId("phase4-assisted-setup").locator("footer button")).toBeDisabled();

  const browserStorage = await page.evaluate(() => ({
    cookie: document.cookie,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    url: window.location.href,
  }));
  expect(JSON.stringify(browserStorage)).not.toContain(state.organiserCookieValue);
  const sessionCookies = (await context.cookies()).filter((cookie) => cookie.name === state.organiserCookieName);
  expect(sessionCookies).toHaveLength(1);
  expect(sessionCookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict" });

  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: /read.?only/i })).toBeVisible();
  const completed = await apiDocument(state, state.completedCompetitionId);
  expect(completed).toMatchObject({
    revision: state.completedRevision,
    status: "completed",
    current_step: "review_publish",
    permission: "read",
    read_only: true,
  });
  expect(completed.values.review_publish?.published_schedule_revision_id).toBe(state.completedScheduleRevisionId);

  await page.goto(`/competitions/${encodeURIComponent(state.completedSlug)}`);
  await expect(page.locator("body")).not.toContainText(/not found|internal error/i);
  const api = await playwrightRequest.newContext({ baseURL: state.apiOrigin });
  try {
    const projectionResponse = await api.get(`/api/v1/public/competitions/${encodeURIComponent(state.completedSlug)}`);
    expect(projectionResponse.status(), await projectionResponse.text()).toBe(200);
    const projection = (await projectionResponse.json()) as { publication: { schedule_version: number } };
    expect(projection.publication.schedule_version).toBe(1);
  } finally {
    await api.dispose();
  }
  expect(failures).toEqual([]);
});

test("authorization, CSRF, and origin boundaries fail closed", async () => {
  const state = await readState();
  const outsider = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: { cookie: `${state.outsiderCookieName}=${state.outsiderCookieValue}` },
  });
  const organiserWithoutCsrf = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: organiserHeaders(state),
  });
  const organiserCrossOrigin = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: {
      ...organiserHeaders(state),
      origin: "https://attacker.example",
      "x-csrf-token": state.csrfToken,
    },
  });
  try {
    const crossTenant = await outsider.get(`/api/v1/competitions/${state.recommendationCompetitionId}/setup-draft`);
    expect(crossTenant.status()).toBe(404);

    const missingCsrf = await organiserWithoutCsrf.post(
      `/api/v1/competitions/${state.recommendationCompetitionId}/setup-draft/resume`,
      { data: { idempotency_key: crypto.randomUUID() } },
    );
    expect(missingCsrf.status()).toBe(403);

    const badOrigin = await organiserCrossOrigin.post(
      `/api/v1/competitions/${state.recommendationCompetitionId}/setup-draft/resume`,
      { data: { idempotency_key: crypto.randomUUID() } },
    );
    expect(badOrigin.status()).toBe(403);
  } finally {
    await outsider.dispose();
    await organiserWithoutCsrf.dispose();
    await organiserCrossOrigin.dispose();
  }
});
