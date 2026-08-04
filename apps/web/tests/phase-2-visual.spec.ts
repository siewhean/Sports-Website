import { expect, test } from "@playwright/test";
import {
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
  openPhase2Scorekeeper,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => {
  installConsoleGuard(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("Phase 2 organiser visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Event-day control room" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-2-organiser.png", { fullPage: true, animations: "disabled" });
});

test("Phase 2 access manager visual baseline", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/access");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Match-scoped passes" })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) <= 900) {
    const privacyControl = page.getByRole("button", { name: "Privacy choices" });
    await expect(privacyControl).toHaveCSS("position", "static");
    const rotations = page.getByRole("button", { name: /Rotate fallback number/ });
    await expect(rotations).toHaveCount(3);
    for (let index = 0; index < (await rotations.count()); index += 1) {
      const rotation = rotations.nth(index);
      await rotation.scrollIntoViewIfNeeded();
      await rotation.focus();
      await expect(rotation).toBeFocused();
    }

    const [privacyBounds, terminalBounds, rotationBounds] = await page.evaluate(() => {
      const absoluteBounds = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          top: bounds.top + window.scrollY,
          right: bounds.right + window.scrollX,
          bottom: bounds.bottom + window.scrollY,
          left: bounds.left + window.scrollX,
        };
      };
      const privacy = document.querySelector(".consent-reopen");
      const terminal = document.querySelector(".p5-takeovers");
      const rotateButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".p5-access-history button"),
      ).filter((button) => button.textContent?.includes("Rotate fallback number"));
      if (!privacy || !terminal || rotateButtons.length !== 3)
        throw new Error("Access manager safety surfaces missing");
      return [absoluteBounds(privacy), absoluteBounds(terminal), rotateButtons.map(absoluteBounds)] as const;
    });
    const overlaps = (first: typeof privacyBounds, second: typeof privacyBounds) =>
      first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    expect(overlaps(privacyBounds, terminalBounds)).toBe(false);
    for (const rotationBoundsItem of rotationBounds) {
      expect(overlaps(privacyBounds, rotationBoundsItem)).toBe(false);
    }
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
  }
  await expect(page).toHaveScreenshot("phase-2-access-manager.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("Phase 2 scorer attribution visual baseline", async ({ page }) => {
  await openPhase2Scorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm goal" })).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.getByRole("button", { name: "Cancel" }).focus();
  await expect(page).toHaveScreenshot("phase-2-scorer-confirmation.png", {
    fullPage: true,
    animations: "disabled",
  });
});

test("Phase 2 public competition visual baseline", async ({ page }) => {
  await page.goto("/competitions/singapore-open");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Singapore Open 2026" })).toBeVisible();
  await expect(page).toHaveScreenshot("phase-2-public.png", { fullPage: true, animations: "disabled" });
});
