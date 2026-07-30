import { expect, test, type Page } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

const organisationId = "79685f62-e0f7-4c41-a329-5532bf41cfa2";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

async function fillCompetition(page: Page) {
  await page.getByLabel("Competition name").fill("National Open");
  await page.getByLabel("Public address").fill("national-open");
  await page.getByLabel("Sport").selectOption("badminton");
  await page.getByLabel("Venue").fill("National Hall");
  await page.getByLabel("Address", { exact: true }).fill("1 Arena Road");
  await page.getByLabel("City or locality (optional)").fill("Singapore");
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
  await expect(page.getByRole("button", { name: "Create competition" })).toBeEnabled();
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
  await expect(page.getByLabel("Organisation")).toHaveValue(organisationId);
  await fillCompetition(page);
  await page.getByRole("button", { name: "Create competition" }).click();

  await expect.poll(() => competitionCalls).toBe(1);
  expect(bootstrapCalls).toBe(0);
});

test("an unavailable organisation service keeps creation disabled and offers retry", async ({ page }) => {
  allowConsoleFailure(page, /server responded with a status of 503/);
  await page.route("**/api/phase3/competitions", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "API_UNAVAILABLE", message: "Unavailable" } }),
    });
  });

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  await expect(page.getByText("Your organisations could not be loaded. Try again before creating a competition.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry organisation list" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create competition" })).toBeDisabled();
});
