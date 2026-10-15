import { expect, test } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("an entry with a blank seed is submitted as seed:null and saved", async ({ page }) => {
  const bodies: Array<{ name: string; seed: unknown }> = [];
  await page.route("**/api/phase3/competitions/*/divisions/*/entries", async (route) => {
    const body = route.request().postDataJSON() as { name: string; seed: unknown };
    bodies.push(body);
    const divisionId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "entry-unseeded",
        division_id: divisionId,
        name: body.name,
        seed: body.seed,
        status: "active",
      }),
    });
  });

  await page.goto("/organiser/competitions/singapore-open/entries");
  await dismissConsent(page);
  const division = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "Add entry" }) })
    .first();
  await division.getByLabel("Entry name").fill("Unseeded team");
  await division.getByLabel("Seed").fill("");
  await division.getByRole("button", { name: "Add entry" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Entry added." })).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ name: "Unseeded team", seed: null });
  await expect(division.getByRole("listitem").filter({ hasText: "Unseeded team" })).toContainText("—");
});
