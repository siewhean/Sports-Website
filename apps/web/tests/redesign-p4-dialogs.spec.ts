import { expect, test, type Page, type Route } from "@playwright/test";
import {
  allowConsoleFailureCount,
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
} from "./helpers/console-guard";
import { competitionId, setupDocument } from "./helpers/phase4-setup-document";

/**
 * Redesign Phase 4 (part 2) dialogs: "Update to latest defaults" on the competition settings page, the Assisted
 * Setup start-date rule-set re-offer, and the shared modal keyboard behaviour. Both BFF endpoints are answered by
 * page.route, so the service worker is blocked to keep those requests observable.
 */
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

const settings = "/organiser/competitions/singapore-open/settings";
const conflictConsoleError = /^console\.error: Failed to load resource: the server responded with a status of 409/u;

function liveRegion(page: Page) {
  return page.getByTestId("phase3-settings").locator("[aria-live='polite']").first();
}

function conflict(route: Route, code: string, details: Record<string, unknown> = {}) {
  return route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message: code, details } }),
  });
}

test.describe("Update to latest defaults", () => {
  test("is only offered when a newer federation pack is known", async ({ page }) => {
    await page.goto(settings);
    await dismissConsent(page);
    await expect(page.getByTestId("phase3-settings")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Latest federation rules" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Update to latest defaults" })).toHaveCount(0);

    await page.goto(`${settings}?update=available`);
    await expect(page.getByRole("heading", { name: "Latest federation rules" })).toBeVisible();
    await expect(page.getByText("Update available")).toBeVisible();
    await expect(page.getByText(/Active pack: .* · Available: 1\.0\.0/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Update to latest defaults" })).toBeEnabled();
  });

  test("updates a draft competition without asking for confirmation", async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route("**/api/phase3/competitions/*/settings/update-defaults", async (route) => {
      bodies.push(route.request().postData() ? route.request().postDataJSON() : null);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 5 }) });
    });
    await page.goto(`${settings}?update=available`);
    await dismissConsent(page);
    await page.getByRole("button", { name: "Update to latest defaults" }).click();
    await expect(liveRegion(page)).toHaveText("Settings reset to latest federation defaults.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(bodies).toEqual([null]);
  });

  test("asks before updating a published competition, then sends confirm_published", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 1);
    const bodies: unknown[] = [];
    await page.route("**/api/phase3/competitions/*/settings/update-defaults", async (route) => {
      bodies.push(route.request().postData() ? route.request().postDataJSON() : null);
      if (bodies.length === 1) {
        await conflict(route, "PUBLISHED_COMPETITION_CONFIRMATION_REQUIRED");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 5 }) });
    });
    await page.goto(`${settings}?update=available`);
    await dismissConsent(page);
    await page.getByRole("button", { name: "Update to latest defaults" }).click();

    const dialog = page.getByRole("dialog", { name: "Competition is published" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Updating rules requires confirmation.");
    await dialog.getByRole("button", { name: "Confirm and proceed" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(liveRegion(page)).toHaveText("Settings reset to latest federation defaults.");
    expect(bodies).toEqual([null, { confirm_published: true }]);
  });

  test("lists affected matches when results exist, then sends confirm_results_affected", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 1);
    const bodies: unknown[] = [];
    await page.route("**/api/phase3/competitions/*/settings/update-defaults", async (route) => {
      bodies.push(route.request().postData() ? route.request().postDataJSON() : null);
      if (bodies.length === 1) {
        await conflict(route, "RESULTS_EXIST_CONFIRMATION_REQUIRED", {
          matches: [
            { id: "9f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f", division_id: "div-open", status: "final" },
            { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", division_id: "div-open", status: "live" },
          ],
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 5 }) });
    });
    await page.goto(`${settings}?update=available`);
    await dismissConsent(page);
    await page.getByRole("button", { name: "Update to latest defaults" }).click();

    const dialog = page.getByRole("dialog", { name: "Match results will be recalculated" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Affected matches (2):");
    await expect(dialog).toContainText("Match 9f0c1d2e… (final)");
    await expect(dialog).toContainText("Match 1a2b3c4d… (live)");
    await dialog.getByRole("button", { name: "Confirm and proceed" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(liveRegion(page)).toHaveText("Settings reset to latest federation defaults.");
    expect(bodies).toEqual([null, { confirm_results_affected: true }]);
  });

  test("Cancel closes the confirmation without sending a second request", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 1);
    const bodies: unknown[] = [];
    await page.route("**/api/phase3/competitions/*/settings/update-defaults", async (route) => {
      bodies.push(route.request().postData() ? route.request().postDataJSON() : null);
      await conflict(route, "PUBLISHED_COMPETITION_CONFIRMATION_REQUIRED");
    });
    await page.goto(`${settings}?update=available`);
    await dismissConsent(page);
    await page.getByRole("button", { name: "Update to latest defaults" }).click();
    const dialog = page.getByRole("dialog", { name: "Competition is published" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(bodies).toEqual([null]);
  });
});

test.describe("modal keyboard", () => {
  test("focus moves in, Tab is trapped, Escape closes and focus returns to the trigger", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 1);
    await page.route("**/api/phase3/competitions/*/settings/update-defaults", (route) =>
      conflict(route, "PUBLISHED_COMPETITION_CONFIRMATION_REQUIRED"),
    );
    await page.goto(`${settings}?update=available`);
    await dismissConsent(page);
    const trigger = page.getByRole("button", { name: "Update to latest defaults" });
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Competition is published" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const proceed = dialog.getByRole("button", { name: "Confirm and proceed" });
    await expect(cancel).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(proceed).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(proceed).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("Assisted Setup start-date rule-set offer", () => {
  const patchBodiesByPage = new WeakMap<Page, Array<Record<string, unknown>>>();
  const patchBodiesFor = (page: Page) => patchBodiesByPage.get(page) ?? [];

  async function openBasics(page: Page) {
    const patchBodies: Array<Record<string, unknown>> = [];
    patchBodiesByPage.set(page, patchBodies);
    let serverDocument = setupDocument({ revision: 4, currentStep: "basics", name: "Singapore Open 2026" });
    await page.route("**/api/phase4/competitions/*/setup-draft/resume", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(serverDocument) }),
    );
    await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
      const request = route.request();
      if (request.method() !== "PATCH") {
        await route.abort();
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      const value = (body.step as { value: { starts_on: string } }).value;
      if (body.confirm_pack_switch === undefined && value.starts_on !== serverDocument.values.basics?.starts_on) {
        await conflict(route, "SPORT_PACK_UPDATE_OFFERED", {
          current_pack_version: "2026.1",
          offered_pack_version: "2027.1",
          lost_overrides: { competition: { periodDurationMinutes: 8 }, divisions: [] },
        });
        return;
      }
      const step = body.step as { value: { starts_on: string; ends_on: string } };
      serverDocument = setupDocument({
        revision: serverDocument.revision + 1,
        currentStep: "basics",
        name: "Singapore Open 2026",
        startsOn: step.value.starts_on,
        endsOn: step.value.ends_on,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ outcome: "saved", document: serverDocument }),
      });
    });
    await page.goto(`/organiser/competitions/${competitionId}/setup?step=basics`);
    await dismissConsent(page);
    await expect(page.getByLabel("Competition name")).toHaveValue("Singapore Open 2026");
    return patchBodies;
  }

  async function offerNewRules(page: Page) {
    // Move the end date first (no rule-set change) so the new start date keeps the basics valid.
    await page.getByLabel("Ends on").fill("2027-01-05");
    await expect(page.getByLabel("Ends on")).toHaveValue("2027-01-05");
    await expect.poll(() => patchBodiesFor(page).length).toBe(1);
    const startsOn = page.getByLabel("Starts on");
    await startsOn.fill("2027-01-04");
    const dialog = page.getByRole("dialog", { name: "Update to latest sport rules?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Changing the start date offers rule set 2027.1.");
    await expect(dialog).toContainText("Custom rules that will be reset: periodDurationMinutes");
    return dialog;
  }

  test("Keep saves the new dates with confirm_pack_switch false", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 2);
    const patchBodies = await openBasics(page);
    const dialog = await offerNewRules(page);
    await dialog.getByRole("button", { name: "Keep 2026.1" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => patchBodies.some((body) => body.confirm_pack_switch === false)).toBe(true);
    const kept = patchBodies.find((body) => body.confirm_pack_switch === false)!;
    expect(kept).toMatchObject({
      step: { step_id: "basics", value: { starts_on: "2027-01-04" } },
    });
    expect(patchBodies.some((body) => body.confirm_pack_switch === true)).toBe(false);
    await expect(page.getByLabel("Starts on")).toHaveValue("2027-01-04");
  });

  test("Switch saves the new dates with confirm_pack_switch true", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 2);
    const patchBodies = await openBasics(page);
    const dialog = await offerNewRules(page);
    await dialog.getByRole("button", { name: "Switch to 2027.1" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => patchBodies.some((body) => body.confirm_pack_switch === true)).toBe(true);
    const switched = patchBodies.find((body) => body.confirm_pack_switch === true)!;
    expect(switched).toMatchObject({
      step: { step_id: "basics", value: { starts_on: "2027-01-04" } },
    });
    await expect(page.getByLabel("Starts on")).toHaveValue("2027-01-04");
  });

  test("keyboard: Tab stays in the offer, Escape keeps the saved date and returns focus", async ({ page }) => {
    allowConsoleFailureCount(page, conflictConsoleError, 2);
    const patchBodies = await openBasics(page);
    const dialog = await offerNewRules(page);
    const keep = dialog.getByRole("button", { name: "Keep 2026.1" });
    const switchRules = dialog.getByRole("button", { name: "Switch to 2027.1" });
    await expect(keep).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(switchRules).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(keep).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(switchRules).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Starts on")).toBeFocused();
    await expect(page.getByLabel("Starts on")).toHaveValue("2026-08-15");
    await expect(page.getByLabel("Ends on")).toHaveValue("2027-01-05");
    expect(patchBodies.some((body) => body.confirm_pack_switch !== undefined)).toBe(false);
  });
});
