import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";
import { competitionId, setupDocument } from "./helpers/phase4-setup-document";

// These tests intercept setup BFF requests. Blocking the worker keeps those
// requests observable to page.route instead of allowing an installed worker
// from a preceding test to answer them outside Playwright's page routing.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

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
    { id: "conflict", kind: "heading", text: "A newer setup version is available", action: "Load latest version" },
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
