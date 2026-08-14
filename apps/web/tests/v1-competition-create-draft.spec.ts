import { expect, test } from "@playwright/test";
import { dismissConsent } from "./helpers/console-guard";

test("unfinished competition creation survives navigation and reload", async ({ page }) => {
  await page.goto("/organiser/competitions/new");
  await dismissConsent(page);

  await page.getByLabel("Competition name").fill("Saved Draft Cup");
  await page.getByLabel("Competition URL").fill("saved-draft-cup");
  await page.getByLabel("Venue").fill("Draft Arena");

  await page.goto("/");
  await page.goto("/organiser/competitions/new");

  await expect(page.getByLabel("Competition name")).toHaveValue("Saved Draft Cup");
  await expect(page.getByLabel("Competition URL")).toHaveValue("saved-draft-cup");
  await expect(page.getByLabel("Venue")).toHaveValue("Draft Arena");

  await page.reload();

  await expect(page.getByLabel("Competition name")).toHaveValue("Saved Draft Cup");
  await expect(page.getByLabel("Competition URL")).toHaveValue("saved-draft-cup");
  await expect(page.getByLabel("Venue")).toHaveValue("Draft Arena");
});
