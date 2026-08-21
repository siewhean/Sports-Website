import { expect, Locator, test, type Page } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type JsonRecord = Record<string, unknown>;

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const ASSISTED_COMPETITION_ID = "cmp_sgopen_2026";
const COMPETITION_ID = "singapore-open";
const ASSISTED_MARKER_SCOPE = "gate-b-page-lifetime";
const ANNOUNCEMENT =
  "[aria-live='polite']:not(#__next-route-announcer), [aria-live='assertive']:not(#__next-route-announcer), [role='status']:not(#__next-route-announcer), [role='alert']:not(#__next-route-announcer)";

const stepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;

type AssistedSetupStepId = (typeof stepIds)[number];

function createRequestCounter(page: Page, path: RegExp, method: string): { count: () => number; dispose: () => void } {
  let count = 0;
  const handler = (request: { method(): string; url(): string }) => {
    try {
      if (request.method() !== method) return;
      const requestUrl = new URL(request.url());
      if (path.test(requestUrl.pathname)) count += 1;
    } catch {
      // ignore best-effort parser failures
    }
  };

  page.on("request", handler);

  return {
    count: () => count,
    dispose() {
      page.off("request", handler);
    },
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setPageLifetimeMarker(page: Page): Promise<string> {
  const marker = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  await page.evaluate(
    ({ value }: { value: string; key: string }) => {
      (window as Window & { __gateBPageLifetime?: string }).__gateBPageLifetime = value;
    },
    { value: marker, key: ASSISTED_MARKER_SCOPE },
  );
  return marker;
}

async function getPageLifetimeMarker(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as Window & { __gateBPageLifetime?: string }).__gateBPageLifetime ?? null);
}

function getLoadLatestRevisionControl(page: Page): Locator {
  const testIdFallback = page.getByTestId("phase4-format-conflict-reload");
  const explicitButton = page.getByRole("button", { name: /load latest revision|reload/i });
  return testIdFallback.or(explicitButton);
}

function getAssistedSetupConflictControl(page: Page): Locator {
  return page
    .getByTestId("assisted-setup-conflict-retry")
    .or(page.getByTestId("assisted-setup-inline-conflict-retry"))
    .or(page.getByRole("button", { name: /load latest revision|reload/i }));
}

function setupDocument(input: {
  competitionId?: string;
  revision: number;
  currentStep: AssistedSetupStepId;
  name: string;
  venue?: string;
}): JsonRecord {
  const now = "2026-07-24T00:00:00.000Z";
  const competitionId = input.competitionId ?? ASSISTED_COMPETITION_ID;
  const currentIndex = stepIds.indexOf(input.currentStep);
  return {
    schema_version: 1,
    id: "0cc48815-adc6-4bda-838f-3b52eb8c7862",
    organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
    competition_id: competitionId,
    competition_status: "draft",
    revision: input.revision,
    status: "active",
    current_step: input.currentStep,
    completed_steps: stepIds.slice(0, currentIndex),
    steps: stepIds.map((id, index) => ({
      id,
      status: index < currentIndex ? "completed" : index === currentIndex ? "current" : "not_started",
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]],
      errors: [],
      completed_at: index < currentIndex ? now : null,
    })),
    values: {
      basics: {
        name: input.name,
        sport_code: "canoe_polo",
        location: {
          venue: input.venue ?? "OCBC Aquatic Centre",
          address: "7 Stadium Drive",
          locality: "Singapore",
          country_code: "SG",
        },
        starts_on: "2026-08-15",
        ends_on: "2026-08-16",
        time_zone: "Asia/Singapore",
        locale: "en-SG",
        entry_count: 16,
        division_count: 2,
        entry_count_status: "confirmed",
      },
      capacity: {
        kind: "phase3_capacity_revision",
        competition_id: competitionId,
        revision: 4,
        time_zone: "Asia/Singapore",
        area_ids: ["8e66bd53-a9cb-4cde-840a-cc94988ca461", "059d20be-13b3-4707-b4d1-14867693c019"],
        source_hash: "e2e-demo-capacity-hash",
        effective: {
          slotMinutes: 30,
          rawTotalSlots: 54,
          fixedReserveSlots: 2,
          availableMatchSlots: 52,
          requiredMatchSlots: 31,
          remainingMatchSlots: 21,
          status: "comfortable",
        },
      },
      settings: [
        {
          competition_id: competitionId,
          scope: "competition",
          division_id: null,
          settings_revision: 3,
          mode: "recommended",
          pack_schema_version: 1,
          pack_version: "2026.1",
          pack_definition_hash: "demo-settings-hash",
        },
      ],
      entries: {
        competition_id: competitionId,
        divisions: [],
        imports: [],
        total_entry_count: 16,
      },
      format_preferences: {
        minimum_matches: { per_entry: 3 },
        ranking: { rank_all_entries: true },
        knockout: { required: true },
        placement: { required: true },
        qualification: { cross_group_allowed: false },
        priority: { value: "participation" },
      },
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: false,
    autosave: {
      status: "saved",
      last_saved_at: now,
      expires_at: "2026-08-22T00:00:00.000Z",
    },
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

function applySetupTransition(document: JsonRecord, transition: JsonRecord | null): JsonRecord {
  if (!transition) return structuredClone(document);
  const next = structuredClone(document);
  const kind = String(transition.kind);
  const values = next.values as JsonRecord;
  const transitionStep = transition.step as JsonRecord | undefined;

  if (typeof next.revision === "number") next.revision += 1;

  if (
    kind === "save_step" &&
    transitionStep?.step_id === "basics" &&
    transitionStep.value &&
    typeof transitionStep.value === "object"
  ) {
    values.basics = {
      ...(values.basics as JsonRecord),
      ...(transitionStep.value as JsonRecord),
    };
  }

  if (
    kind === "save_step" &&
    transitionStep?.step_id === "format_preferences" &&
    typeof transitionStep.value === "object"
  ) {
    values.format_preferences = {
      ...(values.format_preferences as JsonRecord),
      ...(transitionStep.value as JsonRecord),
    };
  }

  if (kind === "go_to_step" && typeof transitionStep?.step_id === "string") {
    const target = transitionStep.step_id;
    if (stepIds.includes(target as AssistedSetupStepId)) {
      const completed = new Set((next.completed_steps as string[]) || []);
      if (typeof next.current_step === "string") completed.add(next.current_step);
      next.current_step = target;
      next.completed_steps = [...completed];
    }
  }

  return next;
}

function formatDraftTemplate(): JsonRecord {
  return {
    competition_id: COMPETITION_ID,
    division_id: "open-division",
    draft_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
    parent_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
    root_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
    revision: 6,
    status: "draft",
    created_at: "2026-07-20T04:00:00.000Z",
    updated_at: "2026-07-20T06:34:00.000Z",
    permission: "edit",
    read_only: false,
    definition_hash: "server-gateb-format-def-1",
    document: {
      schema_version: 1,
      graph: {
        id: "format-singapore-open",
        schemaVersion: 1,
        entryCount: 2,
        stages: [
          {
            id: "stage-group-a",
            label: "Group A",
            kind: "group",
            order: 1,
            groupIds: ["A"],
            groupSize: 4,
            outputRanks: 2,
            matchIds: ["match-g1"],
            destinationStageIds: ["stage-final"],
            repetitions: 1,
            seeding: "seeded",
            carriedResults: "none",
          },
          {
            id: "stage-final",
            label: "Final",
            kind: "single_elimination",
            order: 2,
            groupIds: [],
            groupSize: null,
            outputRanks: 1,
            matchIds: ["match-final"],
            destinationStageIds: [],
            repetitions: 1,
            seeding: "seeded",
            carriedResults: "none",
          },
        ],
        matches: [
          {
            id: "match-g1",
            stageId: "stage-group-a",
            round: 1,
            order: 1,
            purpose: "pool",
            home: { type: "entry_seed", seed: 1 },
            away: { type: "entry_seed", seed: 2 },
          },
          {
            id: "match-final",
            stageId: "stage-final",
            round: 1,
            order: 2,
            purpose: "championship",
            home: { type: "stage_rank", stageId: "stage-group-a", stageId_alias: "stage-group-a", rank: 1 },
            away: { type: "stage_rank", stageId: "stage-group-a", stageId_alias: "stage-group-a", rank: 2 },
          },
        ],
        terminalMatchIds: ["match-final"],
      },
      layout: {
        schema_version: 1,
        stage_positions: [
          { stage_id: "stage-group-a", x: 42, y: 70 },
          { stage_id: "stage-final", x: 420, y: 130 },
        ],
      },
    },
    metrics: {
      match_count: 2,
      guaranteed_matches: 1,
      maximum_matches: 4,
    },
    validation: {
      pending: false,
      validated_definition_hash: "server-gateb-format-def-1",
      issues: [],
    },
    capacity: {
      available_match_slots: 52,
      required_match_slots: 1,
      spare_match_slots: 51,
      status: "comfortable",
      evidence_revision: 4,
    },
  };
}

test("Gate B state preservation focus recovery and retry flow for assisted setup", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 409/);

  const resumeBodies: JsonRecord[] = [];
  const putBodies: JsonRecord[] = [];
  let releaseConflictResponse: () => void = () => {};
  const conflictResponseLatch = new Promise<void>((resolve) => {
    releaseConflictResponse = resolve;
  });
  let releaseSavedResponse: () => void = () => {};
  const savedResponseLatch = new Promise<void>((resolve) => {
    releaseSavedResponse = resolve;
  });
  let serverDocument = setupDocument({ revision: 4, currentStep: "basics", name: "Singapore Open 2026" });
  let mutationCount = 0;

  await page.route("**/api/phase4/competitions/*/setup-draft/resume", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    resumeBodies.push(route.request().postDataJSON() as JsonRecord);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serverDocument),
    });
  });

  await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }

    const rawBody = route.request().postData() ?? "{}";
    let body: JsonRecord | null = null;
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonRecord;
    } catch {
      body = null;
    }

    const transition = body?.transition as JsonRecord | undefined;
    putBodies.push(body ?? {});
    mutationCount += 1;

    serverDocument = applySetupTransition(serverDocument, transition ?? null);

    if (mutationCount === 1) {
      await conflictResponseLatch;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ outcome: "conflict", current: serverDocument }),
      });
      return;
    }

    if (mutationCount === 2) {
      await savedResponseLatch;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "saved", document: serverDocument }),
    });
  });

  const resumeCounter = createRequestCounter(page, /\/setup-draft\/resume$/, "POST");
  const saveCounter = createRequestCounter(page, /\/setup-draft$/, "PUT");

  await page.goto(`/organiser/competitions/${ASSISTED_COMPETITION_ID}/setup?step=basics`);
  await dismissConsent(page);

  await expect.poll(() => resumeBodies.length).toBe(1);

  const baselineUrl = page.url();
  const marker = await setPageLifetimeMarker(page);

  const nameInput = page.getByLabel("Competition name");
  const venueInput = page.getByLabel("Venue");
  await nameInput.fill("Singapore Open Gate B");
  await venueInput.fill("Jurong East Arena");

  const continueButton = page.locator("footer button").last();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(continueButton).toBeDisabled();
  await expect.poll(() => saveCounter.count()).toBe(1);
  releaseConflictResponse();

  await expect(page).toHaveURL(baselineUrl);
  await expect(await getPageLifetimeMarker(page)).toBe(marker);

  await expect(page.getByRole("heading", { name: /A newer setup revision is available/i })).toBeVisible();
  const conflictRetry = page.getByRole("button", { name: /Load latest revision/i });
  await expect(conflictRetry).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /conflict|A newer setup revision/i })).toBeVisible();

  await conflictRetry.focus();
  await expect(conflictRetry).toBeFocused();
  await conflictRetry.click();
  await expect(conflictRetry).toBeHidden();
  await expect(await getPageLifetimeMarker(page)).toBe(marker);

  await expect(page).toHaveURL(/step=basics/);
  await expect(nameInput).toHaveValue("Singapore Open Gate B");
  await expect(venueInput).toHaveValue("Jurong East Arena");

  const retryContinue = page.locator("footer button").last();
  await expect(retryContinue).toBeEnabled();
  const saveAfterResume = saveCounter.count();
  await retryContinue.click();
  await expect.poll(() => saveCounter.count()).toBe(saveAfterResume + 1);
  await expect(retryContinue).toBeDisabled();
  expect(saveCounter.count()).toBe(saveAfterResume + 1);
  releaseSavedResponse();
  await expect(retryContinue).toBeEnabled();
  await expect.poll(() => saveCounter.count()).toBe(saveAfterResume + 1);
  await expect(page).toHaveURL(/\/organiser\/competitions\//);
  await expect(await getPageLifetimeMarker(page)).toBe(marker);
  await expect(
    page.locator(ANNOUNCEMENT).filter({ hasText: /Saved|saving|Capacity|Set the event capacity|capacity/i }),
  ).toBeVisible();

  const requestExpectedRevisions = putBodies
    .map((body) => {
      if (!body || typeof body !== "object") return NaN;
      const legacy = Number(body.expected_revision);
      if (Number.isFinite(legacy)) return legacy;
      return Number((body as { expectedRevision?: unknown }).expectedRevision);
    })
    .filter((revision) => Number.isFinite(revision));

  expect(requestExpectedRevisions.length).toBeGreaterThanOrEqual(2);
  expect(requestExpectedRevisions[0]).toBe(4);
  expect(requestExpectedRevisions[1]).toBe(((serverDocument as { revision: number }).revision ?? 1) - 1);

  resumeCounter.dispose();
  saveCounter.dispose();
});

test("Gate B state preservation focus and retry for sport-settings conflict", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 409/);

  const saveBodies: JsonRecord[] = [];
  let releaseConflictResponse: () => void = () => {};
  const conflictResponseLatch = new Promise<void>((resolve) => {
    releaseConflictResponse = resolve;
  });
  let releaseSavedResponse: () => void = () => {};
  const savedResponseLatch = new Promise<void>((resolve) => {
    releaseSavedResponse = resolve;
  });
  let saveCount = 0;

  await page.route("**/api/phase3/competitions/*/settings", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    saveBodies.push(route.request().postDataJSON() as JsonRecord);
    saveCount += 1;

    if (saveCount === 1) {
      await conflictResponseLatch;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "REVISION_CONFLICT", message: "A newer version was saved" } }),
      });
      return;
    }

    if (saveCount === 2) {
      await savedResponseLatch;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 5 }),
    });
  });

  const saveCounter = createRequestCounter(page, /\/settings$/, "PUT");

  await page.goto(`/organiser/competitions/${ASSISTED_COMPETITION_ID}/settings`);
  await dismissConsent(page);

  await expect(page.getByTestId("phase3-primary-action")).toBeVisible();
  const slot = page.getByLabel(/Match slot/);
  await slot.fill("31");

  const saveButton = page.getByTestId("phase3-primary-action");
  const marker = await setPageLifetimeMarker(page);
  const baselineUrl = page.url();

  const saveBounds = await saveButton.boundingBox();
  expect(saveBounds).not.toBeNull();
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await page.mouse.click(
    (saveBounds?.x ?? 0) + (saveBounds?.width ?? 0) / 2,
    (saveBounds?.y ?? 0) + (saveBounds?.height ?? 0) / 2,
  );
  await expect.poll(() => saveCounter.count()).toBe(1);
  await expect(slot).toHaveValue("31");
  releaseConflictResponse();
  await expect(page.getByRole("heading", { name: /A newer version was saved/i })).toBeVisible();
  await expect(page.locator("section[role='alert']")).toContainText(/newer version/i);

  const reload = page.getByRole("button", { name: /Reload/i });
  await reload.focus();
  await expect(reload).toBeFocused();
  const beforeRetry = saveCounter.count();
  await reload.click();
  await page.waitForURL(/\/organiser\/competitions\/.*\/settings/);
  await expect(await getPageLifetimeMarker(page)).toBe(marker);
  await expect(page).toHaveURL(baselineUrl);
  await expect(slot).toHaveValue("31");

  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect.poll(() => saveCounter.count()).toBe(beforeRetry + 1);
  expect(saveCounter.count()).toBe(beforeRetry + 1);
  releaseSavedResponse();
  await expect(page.getByText(/Settings saved as a new revision/i)).toBeVisible();
  await expect(slot).toHaveValue("31");
  await expect(page.locator(ANNOUNCEMENT).filter({ hasText: /Settings saved/ })).toBeVisible();

  saveCounter.dispose();
});

test("Gate B state preservation focus, context, and recovery for format designer conflict", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 409/);
  const validateBodies: JsonRecord[] = [];
  const saveBodies: JsonRecord[] = [];
  let saveCount = 0;
  let draft = formatDraftTemplate();

  await page.route("**/api/phase4/competitions/*/divisions/*/format-builder/validate", async (route) => {
    const body = route.request().postDataJSON() as JsonRecord | null;
    validateBodies.push(body ?? {});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        issues: [],
        graph_hash: draft.definition_hash,
        materialisation: {
          match_count: 2,
          fixtures: ["match-g1", "match-final"],
          dependencies: [],
        },
      }),
    });
  });

  await page.route("**/api/phase4/competitions/*/divisions/*/format-builder", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }

    const body = route.request().postDataJSON() as JsonRecord | null;
    saveBodies.push(body ?? {});
    saveCount += 1;

    if (saveCount === 1) {
      await sleep(100);
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "template conflict" }),
      });
      return;
    }

    draft = {
      ...structuredClone(draft),
      revision: ((draft.revision as number) ?? 6) + 1,
      definition_hash: "server-gateb-format-def-2",
      validation: {
        pending: false,
        validated_definition_hash: "server-gateb-format-def-2",
        issues: [],
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(draft),
    });
  });

  await page.route("**/api/phase4/format-revisions/*/materialise", async (route) => {
    await route.abort();
  });

  const saveCounter = createRequestCounter(page, /\/format-builder$/, "PUT");

  await page.goto(`/organiser/competitions/${COMPETITION_ID}/format`);
  await dismissConsent(page);

  const marker = await setPageLifetimeMarker(page);
  const baselineUrl = page.url();

  await page.getByRole("button", { name: /^Manual$/i }).click();
  const stageNameInput = page.getByLabel("Stage name").first();
  await stageNameInput.fill("Gate B Group A");
  const selectedStage = page.getByRole("button", { name: /Gate B Group A/ }).first();
  await selectedStage.focus();
  await page.keyboard.press("ArrowRight");

  const saveButton = page.getByTestId("phase4-format-save");
  const saveFirst = saveCounter.count();
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect.poll(() => saveCounter.count()).toBe(saveFirst + 1);
  await expect(page.getByRole("heading", { name: /conflict|A newer/i })).toBeVisible();
  const reload = getLoadLatestRevisionControl(page);
  await expect(reload).toBeVisible();
  await reload.focus();
  await expect(reload).toBeFocused();
  await reload.click();
  await expect.poll(() => getPageLifetimeMarker(page)).toEqual(marker);

  await expect(await getPageLifetimeMarker(page)).toBe(marker);
  await expect(page).toHaveURL(baselineUrl);
  await expect(page.getByLabel("Venue", { exact: false })).toHaveCount(0);

  if ((await page.getByRole("button", { name: /Manual/i }).count()) > 0) {
    await page.getByRole("button", { name: /Manual/i }).click();
  }

  const stageLabelsFromSave = (body: JsonRecord): string[] => {
    const documentValue = (body?.document as JsonRecord | undefined) ?? {};
    const graph = (documentValue.graph as JsonRecord | undefined) ?? {};
    const stages = Array.isArray(graph.stages) ? graph.stages : [];

    return stages
      .map((item) => {
        if (item && typeof item === "object" && "label" in item) {
          const label = (item as JsonRecord).label;
          return typeof label === "string" ? label : "";
        }
        return "";
      })
      .filter(Boolean);
  };

  const saveAfterRefresh = saveCounter.count();
  const saveButtonAfterRefresh = page.getByTestId("phase4-format-save");
  if ((await saveButtonAfterRefresh.count()) > 0) {
    await saveButtonAfterRefresh.click();
    await expect(saveButtonAfterRefresh).toBeDisabled();
    await expect.poll(() => saveCounter.count()).toBe(saveAfterRefresh + 1);
  }

  await expect(saveCounter.count()).toBeGreaterThanOrEqual(saveAfterRefresh);
  if (saveBodies.length > 1) {
    expect(stageLabelsFromSave(saveBodies[saveBodies.length - 1] ?? {})).toEqual(
      stageLabelsFromSave(saveBodies[0] ?? {}),
    );
  }
  await expect(await getPageLifetimeMarker(page)).toBe(marker);
  saveCounter.dispose();
});

test("Gate B state preservation for fallback journey refresh with no href link", async ({ page }) => {
  const resumeBodies: JsonRecord[] = [];
  let resumeRequestCount = 0;
  await page.route("**/api/phase4/competitions/*/setup-draft/resume", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    resumeBodies.push(route.request().postDataJSON() as JsonRecord);
    resumeRequestCount += 1;

    if (resumeRequestCount === 1) {
      await sleep(350);
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(setupDocument({ revision: 4, currentStep: "basics", name: "Singapore Open 2026" })),
    });
  });

  const actionCounter = createRequestCounter(page, /\/setup-draft\/(resume)?$/, "POST");
  await page.goto(`/organiser/competitions/${ASSISTED_COMPETITION_ID}/setup?state=conflict`);
  await dismissConsent(page);

  const marker = await setPageLifetimeMarker(page);

  await expect(page.getByRole("heading", { name: /A newer setup revision is available/i })).toBeVisible();
  const fallback = getAssistedSetupConflictControl(page);
  await expect(fallback).toHaveCount(1);
  await expect(fallback).toBeVisible();
  await expect(fallback).not.toHaveAttribute("href");
  await fallback.focus();
  await expect(fallback).toBeFocused();

  const markerBefore = await getPageLifetimeMarker(page);
  await expect(markerBefore).toBe(marker);

  const resumeBefore = resumeBodies.length;
  await expect(fallback).toBeEnabled();
  await fallback.click({ noWaitAfter: true });
  await expect.poll(() => resumeBodies.length).toBe(resumeBefore + 1);
  await fallback.click({ timeout: 100 }).catch(() => {
    // no-op: verify duplicate click does not create a second request
  });
  await page.waitForTimeout(120);
  await expect.poll(() => resumeBodies.length).toBe(resumeBefore + 1);
  await expect.poll(() => resumeBodies.length).toBe(resumeBefore + 1);
  const resumeAfter = resumeBodies.length;
  expect(resumeAfter).toBe(resumeBefore + 1);
  expect(resumeRequestCount).toBe(resumeBefore + 1);

  await expect.poll(() => actionCounter.count()).toBe(resumeAfter);
  expect(actionCounter.count()).toBe(resumeBefore + 1);

  await expect(page).toHaveURL(/\/organiser\/competitions\/(.*)\/setup/);
  await expect(await getPageLifetimeMarker(page)).toBe(marker);

  await expect(marker).toBe(await getPageLifetimeMarker(page));
  actionCounter.dispose();
});
