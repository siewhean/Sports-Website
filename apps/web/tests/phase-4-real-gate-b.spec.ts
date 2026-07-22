import { readFile } from "node:fs/promises";
import { expect, request as playwrightRequest, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
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

type SetupDocument = Readonly<{
  organisation_id: string;
  competition_id: string;
  revision: number;
  status: string;
  current_step: string;
  permission: string;
  read_only: boolean;
  values: {
    basics: unknown;
    capacity: unknown;
    settings: unknown;
    entries: unknown;
    format_preferences: unknown;
    format_recommendations: {
      selected_recommendation_id: string | null;
      recommendations: Array<{ id: string; name: string }>;
    } | null;
    schedule_review: { schedule_revision_id: string } | null;
    review_publish: { published_schedule_revision_id: string | null } | null;
  };
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

function mutationHeaders(state: GateBRealState) {
  return {
    ...organiserHeaders(state),
    origin: state.webOrigin,
    "x-csrf-token": state.csrfToken,
  };
}

async function apiDocument(state: GateBRealState, competitionId: string): Promise<SetupDocument> {
  const context = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: organiserHeaders(state),
  });
  try {
    const response = await context.get(`/api/v1/competitions/${competitionId}/setup-draft`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as SetupDocument;
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

async function successfulJson<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  return JSON.parse(body) as T;
}

async function saveSetupStep(
  api: APIRequestContext,
  competitionId: string,
  document: SetupDocument,
  stepId: "basics" | "capacity" | "settings" | "entries" | "format_preferences",
  value: unknown,
): Promise<SetupDocument> {
  const response = await api.put(`/api/v1/competitions/${competitionId}/setup-draft`, {
    data: {
      expected_revision: document.revision,
      idempotency_key: crypto.randomUUID(),
      transition: { kind: "save_step", step: { step_id: stepId, value } },
    },
  });
  const saved = await successfulJson<{ outcome: string; document: SetupDocument }>(response);
  expect(["saved", "idempotent_replay"]).toContain(saved.outcome);
  return saved.document;
}

async function seedBrowserJourney(state: GateBRealState) {
  const authority = await apiDocument(state, state.recommendationCompetitionId);
  const api = await playwrightRequest.newContext({
    baseURL: state.apiOrigin,
    extraHTTPHeaders: mutationHeaders(state),
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  try {
    const competition = await successfulJson<{ id: string }>(
      await api.post("/api/v1/competitions/phase3", {
        data: {
          organisation_id: authority.organisation_id,
          name: `Browser Journey ${suffix}`,
          slug: `browser-journey-${suffix}`,
          sport_code: "badminton",
          venue: "Gate B Browser Hall",
          address: "1 Browser Journey Road",
          locality: "Singapore",
          country_code: "SG",
          starts_on: "2027-11-01",
          ends_on: "2027-11-01",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
      }),
    );
    const division = await successfulJson<{ id: string }>(
      await api.post(`/api/v1/competitions/${competition.id}/divisions`, {
        data: { name: "Singles", code: "S", entry_limit: 8 },
      }),
    );
    for (let seed = 1; seed <= 8; seed += 1) {
      await successfulJson(
        await api.post(`/api/v1/competitions/${competition.id}/divisions/${division.id}/entries`, {
          data: { name: `Browser Player ${seed}`, entry_type: "individual", seed },
        }),
      );
    }
    await successfulJson(
      await api.put(`/api/v1/competitions/${competition.id}/capacity`, {
        data: {
          revision: 1,
          timezone: "Asia/Singapore",
          areas: [
            {
              name: "Court 1",
              sort_order: 0,
              slot_minutes: 40,
              fixed_reserve_slots: 0,
              availability: [{ date: "2027-11-01", start_time: "08:00", end_time: "22:00" }],
              unavailable: [],
            },
          ],
        },
      }),
    );
    const created = await successfulJson<{ document: SetupDocument }>(
      await api.post(`/api/v1/competitions/${competition.id}/setup-draft`, {
        data: { idempotency_key: crypto.randomUUID() },
      }),
    );
    let document = created.document;
    for (const stepId of ["basics", "capacity", "settings", "entries"] as const) {
      const value = document.values[stepId];
      expect(value, `Expected canonical ${stepId} evidence`).not.toBeNull();
      document = await saveSetupStep(api, competition.id, document, stepId, value);
    }
    document = await saveSetupStep(api, competition.id, document, "format_preferences", {
      minimum_matches: { per_entry: 1 },
      ranking: { rank_all_entries: false },
      knockout: { required: true },
      placement: { required: false },
      qualification: { cross_group_allowed: true },
      priority: { value: "speed" },
    });
    const recommendation = document.values.format_recommendations?.recommendations[0];
    if (!recommendation) throw new Error("Browser journey did not generate a canonical format recommendation");
    return { competitionId: competition.id, recommendationName: recommendation.name };
  } finally {
    await api.dispose();
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

test("organiser UI selects, generates, accepts, locks, publishes, and completes from clean HTTP prerequisites", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "State-mutating organiser journey runs once on desktop");
  const state = await readState();
  const journey = await seedBrowserJourney(state);
  const failures = trackFailedApplicationResponses(page);

  await page.goto(`/organiser/competitions/${encodeURIComponent(journey.competitionId)}/setup`);
  await dismissConsent(page);
  const recommendation = page.locator("article").filter({ hasText: journey.recommendationName });
  await expect(recommendation).toBeVisible({ timeout: 20_000 });
  await recommendation.getByRole("button").click();
  await expect(page.getByTestId("phase4-assisted-setup")).toContainText(/Schedule/i);

  await page.goto(`/organiser/competitions/${encodeURIComponent(journey.competitionId)}/schedule`);
  await expect(page.getByTestId("phase4-schedule")).toBeVisible();
  await page.getByRole("button", { name: /Generate Balanced/i }).first().click();
  const useSchedule = page.getByRole("button", { name: "Use this schedule", exact: true });
  await expect(useSchedule).toBeEnabled({ timeout: 60_000 });
  await useSchedule.click();

  const lock = page.getByRole("button", { name: /^Lock$/i });
  await expect(lock).toBeEnabled({ timeout: 20_000 });
  await lock.click();
  await expect(page.getByRole("button", { name: /^Unlock$/i })).toBeVisible({ timeout: 20_000 });

  const publish = page.getByRole("button", { name: /^Publish schedule$/i });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByTestId("phase4-schedule")).toContainText(/Schedule published/i, { timeout: 20_000 });

  await page.goto(`/organiser/competitions/${encodeURIComponent(journey.competitionId)}/setup`);
  const complete = page.getByTestId("phase4-assisted-setup").locator("footer button").last();
  await expect(complete).toBeEnabled({ timeout: 20_000 });
  await complete.click();
  await expect(page.getByRole("status").filter({ hasText: /read.?only/i })).toBeVisible({ timeout: 20_000 });

  const completed = await apiDocument(state, journey.competitionId);
  expect(completed).toMatchObject({ status: "completed", current_step: "review_publish", permission: "read", read_only: true });
  const revisionId = completed.values.review_publish?.published_schedule_revision_id;
  expect(revisionId).toBeTruthy();
  expect(completed.values.schedule_review?.schedule_revision_id).toBe(revisionId);
  const revision = await apiScheduleRevision(state, revisionId!);
  expect(revision).toMatchObject({ id: revisionId, status: "published" });
  expect(revision.assignment_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(failures).toEqual([]);
});

test("accepted schedule survives resume and lock overlay", async ({ page }, testInfo) => {
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
  await expect(page.getByRole("button", { name: /^Unlock$/i })).toBeVisible({ timeout: 20_000 });

  const revision = await apiScheduleRevision(state, state.acceptedScheduleRevisionId);
  expect(revision).toMatchObject({ id: state.acceptedScheduleRevisionId, status: "ready_for_review" });
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
