import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type State = {
  organisationId: string;
  fixtureKey: string;
  organiserCookie: string;
  webOrigin: string;
};

async function state(projectName: string): Promise<State> {
  const stateFile = process.env.PHASE4_E2E_STATE_FILE;
  if (!stateFile) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(stateFile, "utf8")) as { projects: Record<string, State> };
  const value = parsed.projects[projectName];
  if (!value) throw new Error(`No V1 competition fixture exists for ${projectName}`);
  return value;
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("all competition inputs survive navigation and signed-in home reflects the organiser", async ({ page, context }, testInfo) => {
  const seed = await state(testInfo.project.name);
  await installConsoleGuard(page);
  const [cookieName, cookieValue] = seed.organiserCookie.split("=", 2) as [string, string];
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: seed.webOrigin, httpOnly: true, sameSite: "Lax" },
  ]);

  const values = {
    organisation: seed.organisationId,
    name: "V1 Complete Saved Draft",
    slug: `v1-saved-draft-${seed.fixtureKey}`,
    sport: "canoe_polo",
    venue: "Kallang Complete Arena",
    address: "10 Stadium Lane",
    locality: "Singapore",
    country: "SG",
    startsOn: "2027-09-11",
    endsOn: "2027-09-12",
    timezone: "Asia/Singapore",
    locale: "en-SG",
  } as const;

  const assertEveryField = async () => {
    await expect(page.getByLabel("Organisation")).toHaveValue(values.organisation);
    await expect(page.getByLabel("Competition name")).toHaveValue(values.name);
    await expect(page.getByLabel("Public address")).toHaveValue(values.slug);
    await expect(page.getByLabel("Sport")).toHaveValue(values.sport);
    await expect(page.getByLabel("Venue")).toHaveValue(values.venue);
    await expect(page.getByLabel("Address", { exact: true })).toHaveValue(values.address);
    await expect(page.getByLabel("Locality")).toHaveValue(values.locality);
    await expect(page.getByLabel("Country code")).toHaveValue(values.country);
    await expect(page.getByLabel("Start date")).toHaveValue(values.startsOn);
    await expect(page.getByLabel("End date")).toHaveValue(values.endsOn);
    await expect(page.getByLabel("Time zone")).toHaveValue(values.timezone);
    await expect(page.getByLabel("Locale")).toHaveValue(values.locale);
  };

  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);
  await page.getByLabel("Organisation").selectOption(values.organisation);
  await page.getByLabel("Competition name").fill(values.name);
  await page.getByLabel("Public address").fill(values.slug);
  await page.getByLabel("Sport").selectOption(values.sport);
  await page.getByLabel("Venue").fill(values.venue);
  await page.getByLabel("Address", { exact: true }).fill(values.address);
  await page.getByLabel("Locality").fill(values.locality);
  await page.getByLabel("Country code").fill(values.country);
  await page.getByLabel("Start date").fill(values.startsOn);
  await page.getByLabel("End date").fill(values.endsOn);
  await page.getByLabel("Time zone").fill(values.timezone);
  await page.getByLabel("Locale").fill(values.locale);
  await assertEveryField();

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Phase 4 E2E Organiser", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);

  await page.goto("/organiser/competitions/new");
  await assertEveryField();
  await page.reload();
  await assertEveryField();
});
