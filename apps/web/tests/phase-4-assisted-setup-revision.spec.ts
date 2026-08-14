import { expect, test } from "@playwright/test";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

// These tests intercept setup BFF requests. Blocking the worker keeps those
// requests observable to page.route instead of allowing an installed worker
// from a preceding test to answer them outside Playwright's page routing.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const competitionId = "cmp_sgopen_2026";
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

function setupDocument(input: {
  revision: number;
  currentStep: (typeof stepIds)[number];
  name: string;
}): Phase4SetupDocument {
  const currentIndex = stepIds.indexOf(input.currentStep);
  const now = "2026-07-22T00:00:00.000Z";
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
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: index < currentIndex ? now : null,
    })),
    values: {
      basics: {
        name: input.name,
        sport_code: "canoe_polo",
        location: {
          venue: "OCBC Aquatic Centre",
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

test("production Assisted Setup resumes, PATCHes in place, then advances with the returned revision", async ({
  page,
}) => {
  const resumeBodies: Array<Record<string, unknown>> = [];
  const patchBodies: Array<Record<string, unknown>> = [];
  const putBodies: Array<Record<string, unknown>> = [];

  let serverDocument = setupDocument({ revision: 4, currentStep: "basics", name: "Singapore Open 2026" });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "matchday-assisted-setup-draft",
      JSON.stringify({ revision: 999, current_step: "review_publish", name: "Poisoned browser draft" }),
    );
  });
  await page.route("**/api/phase4/competitions/*/setup-draft/resume", async (route) => {
    resumeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serverDocument),
    });
  });
  await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "PATCH") {
      patchBodies.push(body);
      const step = body.step as { value: { name: string } };
      serverDocument = setupDocument({ revision: 5, currentStep: "basics", name: step.value.name });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "saved",
          document: serverDocument,
        }),
      });
      return;
    }
    if (request.method() === "PUT") {
      putBodies.push(body);
      const transition = body.transition as { kind: string; step?: { value?: { name?: string } } };
      expect(transition.kind).toBe("save_step");
      serverDocument = setupDocument({
        revision: 6,
        currentStep: "capacity",
        name: transition.step?.value?.name ?? "Updated Canoe Polo Cup",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "saved",
          document: serverDocument,
        }),
      });
      return;
    }
    await route.abort();
  });

  await page.goto(`/organiser/competitions/${competitionId}/setup?step=basics`);
  await dismissConsent(page);
  await expect.poll(() => resumeBodies.length).toBe(1);
  expect(resumeBodies[0]?.idempotency_key).toEqual(expect.any(String));
  await expect(page.getByLabel("Competition name")).toHaveValue("Singapore Open 2026");
  await expect(page.getByText("Poisoned browser draft")).toHaveCount(0);

  await page.getByLabel("Competition name").fill("Updated Canoe Polo Cup");
  await expect.poll(() => patchBodies.length).toBe(1);
  expect(patchBodies[0]).toMatchObject({
    expected_revision: 4,
    step: {
      step_id: "basics",
      value: { name: "Updated Canoe Polo Cup", sport_code: "canoe_polo" },
    },
  });

  await page.getByRole("button", { name: /Continue to capacity/i }).click();
  await expect(page.getByRole("heading", { name: "Set the event capacity" })).toBeVisible();
  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]).toMatchObject({
    expected_revision: 5,
    transition: {
      kind: "save_step",
      step: { step_id: "basics", value: { name: "Updated Canoe Polo Cup" } },
    },
  });

  await page.reload();
  await expect.poll(() => resumeBodies.length).toBe(2);
  await expect(page.getByRole("heading", { name: "Set the event capacity" })).toBeVisible();
  await expect(page.getByText("Poisoned browser draft")).toHaveCount(0);
});

test("rapid Continue interaction after resume does not skip a setup step", async ({ page }) => {
  const resumeBodies: Array<Record<string, unknown>> = [];
  const putBodies: Array<Record<string, unknown>> = [];
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  await page.route("**/api/phase4/competitions/*/setup-draft/resume", async (route) => {
    resumeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await resumeGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(setupDocument({ revision: 4, currentStep: "basics", name: "Singapore Open 2026" })),
    });
  });
  await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    putBodies.push(body);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "saved",
        document: setupDocument({ revision: 5, currentStep: "capacity", name: "Singapore Open 2026" }),
      }),
    });
  });

  await page.goto(`/organiser/competitions/${competitionId}/setup?step=basics`);
  await dismissConsent(page);
  await expect.poll(() => resumeBodies.length).toBe(1);
  await expect(page.getByRole("button", { name: /Saving/i })).toBeDisabled();
  releaseResume();
  const continueButton = page.getByRole("button", { name: /Continue to capacity/i });
  await expect(continueButton).toBeEnabled();
  await continueButton.dblclick();
  await expect(page.getByRole("heading", { name: "Set the event capacity" })).toBeVisible();
  await page.waitForTimeout(150);
  expect(putBodies).toHaveLength(1);
});

test("empty setup accepts the API create wrapper and reloads the canonical server seed", async ({ page }) => {
  const postBodies: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "matchday-assisted-setup-draft",
      JSON.stringify({ revision: 999, current_step: "review_publish", name: "Poisoned browser draft" }),
    );
  });
  await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
    expect(route.request().method()).toBe("POST");
    postBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document: setupDocument({ revision: 1, currentStep: "basics", name: "Transient wrapper seed" }),
        idempotent_replay: false,
      }),
    });
  });

  await page.goto(`/organiser/competitions/${competitionId}/setup?state=empty&step=basics`);
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Start assisted setup" })).toBeVisible();
  await page.getByRole("button", { name: "Start setup" }).click();

  await expect.poll(() => postBodies.length).toBe(1);
  expect(postBodies[0]?.idempotency_key).toEqual(expect.any(String));
  await expect(page).toHaveURL(`/organiser/competitions/${competitionId}/setup?step=basics`);
  await expect(page.getByLabel("Competition name")).toHaveValue("Singapore Open 2026");
  await expect(page.getByText("Poisoned browser draft")).toHaveCount(0);
  await expect(page.getByText("Transient wrapper seed")).toHaveCount(0);
});

test("setup states are explicit and viewers cannot send mutations", async ({ page }) => {
  const states = [
    { id: "loading", kind: "label", text: "Loading assisted setup" },
    { id: "empty", kind: "heading", text: "Start assisted setup", action: "Start setup" },
    { id: "offline", kind: "heading", text: "Editing paused while offline" },
    { id: "permission", kind: "heading", text: "You do not have permission to edit this setup" },
    { id: "conflict", kind: "heading", text: "A newer setup revision is available", action: "Load latest revision" },
    { id: "expired", kind: "heading", text: "This setup draft has expired", action: "Reload expiry status" },
  ] as const;

  for (const state of states) {
    await page.goto(`/organiser/competitions/${competitionId}/setup?state=${state.id}`);
    if (state.kind === "label") await expect(page.getByLabel(state.text)).toBeVisible();
    else await expect(page.getByRole("heading", { name: state.text })).toBeVisible();
    if ("action" in state) await expect(page.getByRole("button", { name: state.action })).toBeVisible();
    if (state.id === "expired") await expect(page.getByRole("banner").getByText("Draft expired")).toBeVisible();
  }

  let mutations = 0;
  await page.route("**/api/phase4/competitions/*/setup-draft**", async (route) => {
    mutations += 1;
    await route.abort();
  });
  await page.goto(`/organiser/competitions/${competitionId}/setup?state=read-only&step=capacity`);
  await expect(page.getByTestId("phase4-assisted-setup").getByText("This setup is read only")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue to settings/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await page.waitForTimeout(100);
  expect(mutations).toBe(0);
});
