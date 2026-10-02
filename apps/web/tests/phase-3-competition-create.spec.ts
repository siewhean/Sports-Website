import { expect, test, type Page } from "@playwright/test";
import {
  allowConsoleFailure,
  allowConsoleFailureCount,
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
} from "./helpers/console-guard";

// Requests are mocked here; keep service-worker fetches from bypassing page routes.
test.use({ serviceWorkers: "block" });

const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

async function fillCompetition(page: Page) {
  await page.getByLabel("Competition name").fill("National Open");
  await expect(page.getByLabel("Public address")).toHaveValue("national-open");
  await page.getByLabel("Sport").selectOption("badminton");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Venue name").fill("National Hall");
  await page.getByLabel("Address", { exact: true }).fill("1 Arena Road");
  await page.getByLabel("City or locality (optional)").fill("Singapore");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Start date").fill("2027-05-01");
  await page.getByLabel("End date").fill("2027-05-02");
}

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("a first-time organiser can create a competition without a pre-existing organisation", async ({ page }) => {
  let bootstrapCalls = 0;
  let competitionCalls = 0;

  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    bootstrapCalls += 1;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: organisationId,
        name: "Organiser workspace",
        role: "owner",
        created: true,
      }),
    });
  });
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    competitionCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      organisation_id: organisationId,
      name: "National Open",
      slug: "national-open",
      sport_code: "badminton",
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });

  await page.goto("/organiser");
  await dismissConsent(page);
  await page.getByRole("link", { name: "Create competition" }).click();
  await expect(page).toHaveURL(/\/organiser\/competitions\/new$/u);
  await expect(page.getByLabel("Organisation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();

  await expect.poll(() => bootstrapCalls).toBe(1);
  await expect.poll(() => competitionCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("an existing writable organisation is selected and bootstrap is not called", async ({ page }) => {
  let bootstrapCalls = 0;
  let competitionCalls = 0;

  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    bootstrapCalls += 1;
    await route.abort();
  });
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: organisationId, name: "National Sports", role: "organiser" }]),
      });
      return;
    }
    competitionCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({ organisation_id: organisationId });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await expect(page.getByLabel("Organisation")).toHaveCount(0);
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();

  await expect.poll(() => competitionCalls).toBe(1);
  expect(bootstrapCalls).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("an unavailable organisation list uses the default workspace on creation", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 503/);
  let competitionCalls = 0;
  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: organisationId,
        name: "Organiser workspace",
        role: "owner",
        created: false,
      }),
    });
  });
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "API_UNAVAILABLE", message: "Unavailable" } }),
      });
      return;
    }
    competitionCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({ organisation_id: organisationId });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await expect(page.getByLabel("Organisation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect.poll(() => competitionCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("multiple writable organisations submit the chosen owner without bootstrap", async ({ page }) => {
  const secondOrganisationId = "ed3a2fc8-c8c2-4819-a2f1-d4bb8c915c2a";
  let bootstrapCalls = 0;
  let competitionCalls = 0;
  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    bootstrapCalls += 1;
    await route.abort();
  });
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: organisationId, name: "National Sports", role: "owner" },
          { id: secondOrganisationId, name: "Community Sports", role: "organiser" },
        ]),
      });
      return;
    }
    competitionCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({ organisation_id: secondOrganisationId });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await expect(page.getByLabel("Organisation")).toBeVisible();
  await page.getByLabel("Competition name").fill("National Open");
  await page.getByLabel("Sport").selectOption("badminton");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Organisation")).toBeFocused();
  await page.getByLabel("Organisation").selectOption(secondOrganisationId);
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect.poll(() => competitionCalls).toBe(1);
  expect(bootstrapCalls).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("workspace setup failure preserves details and permits a successful retry", async ({ page }) => {
  allowConsoleFailureCount(page, /server responded with a status of 503/, 1);
  let bootstrapCalls = 0;
  let competitionCalls = 0;
  await page.route("**/api/phase3/organisations/bootstrap", async (route) => {
    bootstrapCalls += 1;
    await route.fulfill({
      status: bootstrapCalls === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        bootstrapCalls === 1
          ? { error: { code: "API_UNAVAILABLE", message: "Unavailable" } }
          : { id: organisationId, name: "Organiser workspace", role: "owner", created: true },
      ),
    });
  });
  await page.route("**/api/phase3/competitions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    competitionCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({ organisation_id: organisationId, name: "National Open" });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: competitionId,
        status: "draft",
        sport_code: "badminton",
        revision: 1,
        account_default_applied: false,
      }),
    });
  });
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "We could not prepare your organiser workspace." }),
  ).toContainText("Your details are saved. Try creating the competition again.");
  expect(competitionCalls).toBe(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("matchday-competition-create-draft-v1") ?? "null"),
  );
  expect(saved).toMatchObject({ name: "National Open", sport_code: "badminton", starts_on: "2027-05-01" });
  await expect(page.getByLabel("Start date")).toHaveValue("2027-05-01");
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect.poll(() => competitionCalls).toBe(1);
  expect(bootstrapCalls).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/organiser/competitions/${competitionId}/setup`));
});

test("an unauthenticated organiser can start the MATCHDAY sign-in flow from competition creation", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 401/);
  await page.route("**/api/phase3/competitions", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "Sign in required" } }),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  await expect(page.getByRole("link", { name: "Sign in to load organisations" })).toHaveAttribute(
    "href",
    `/api/v1/identity/authorize?return_to=${encodeURIComponent(
      `${new URL(page.url()).origin}/organiser/competitions/new`,
    )}`,
  );
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("step changes settle heading focus before the next field accepts immediate typing", async ({ page }, testInfo) => {
  await page.route("**/api/phase3/competitions", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Competition name").fill("National Open");
  await page.getByLabel("Sport").selectOption("badminton");
  // Hold post-click animation frames so the regression exercises immediate typing
  // before deferred focus work, without adding input delays or retries.
  await page.evaluate(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const deferredFrames: FrameRequestCallback[] = [];
    let holdFrames = false;
    document.addEventListener(
      "click",
      () => {
        holdFrames = true;
      },
      { capture: true, once: true },
    );
    window.requestAnimationFrame = (callback) => {
      if (holdFrames) {
        deferredFrames.push(callback);
        return -deferredFrames.length;
      }
      return nativeFrame(callback);
    };
    Object.defineProperty(window, "flushDeferredFocus", {
      value: () => {
        holdFrames = false;
        const callbacks = deferredFrames.splice(0);
        const before = document.activeElement?.id;
        callbacks.forEach((callback) => callback(performance.now()));
        return {
          callbackSources: callbacks.map((callback) => callback.toString()),
          before,
          after: document.activeElement?.id,
        };
      },
    });
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Venue", exact: true })).toBeVisible();
  const venue = page.getByLabel("Venue name");
  await venue.focus();
  const focusState = await page.evaluate(() => Reflect.get(window, "flushDeferredFocus")());
  await testInfo.attach("step-focus-interleaving", {
    body: JSON.stringify(focusState),
    contentType: "application/json",
  });
  await expect(venue).toBeFocused();
  await page.keyboard.insertText("Immediate venue");
  await expect(venue).toHaveValue("Immediate venue");
  await page.getByLabel("Address", { exact: true }).fill("1 Arena Road");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Dates and time" })).toBeVisible();
});
