import { expect, test, type Page } from "@playwright/test";

const formatCanvas = "[data-testid='format-canvas']";

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("palette drop and click fallback add stages at usable positions", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/format");

  const canvas = page.locator(formatCanvas);
  const stages = canvas.locator("[data-stage-id]");
  await expect(stages).toHaveCount(4);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (!canvasBox) return;

  await page.getByRole("button", { name: "Knockout", exact: true }).dragTo(canvas, {
    targetPosition: { x: canvasBox.width - 1, y: canvasBox.height - 1 },
  });
  await expect(stages).toHaveCount(5);
  const droppedStage = canvas.locator('[data-stage-id^="stage-knockout-"]');
  await expect(droppedStage).toHaveAttribute("data-stage-x", /\d+/);
  await expect(droppedStage).toHaveAttribute("data-stage-y", /\d+/);
  expect(Number(await droppedStage.getAttribute("data-stage-x"))).toBeCloseTo(canvasBox.width - 204, 0);
  expect(Number(await droppedStage.getAttribute("data-stage-y"))).toBeCloseTo(canvasBox.height - 124, 0);

  await page.getByRole("button", { name: "Placement", exact: true }).click();
  await expect(stages).toHaveCount(6);
  await expect(canvas.locator('[data-stage-id^="stage-placement-"]')).toBeVisible();

  const poolA = canvas.locator('[data-stage-id="pool-a"]');
  await page.getByRole("button", { name: "Group stage", exact: true }).dragTo(poolA);
  await expect(stages).toHaveCount(7);
  const collisionSafeStage = canvas.locator('[data-stage-id^="stage-groups-"]');
  const droppedX = Number(await collisionSafeStage.getAttribute("data-stage-x"));
  const droppedY = Number(await collisionSafeStage.getAttribute("data-stage-y"));
  const poolX = Number(await poolA.getAttribute("data-stage-x"));
  const poolY = Number(await poolA.getAttribute("data-stage-y"));
  expect(Math.abs(droppedX - poolX) >= 196 || Math.abs(droppedY - poolY) >= 116).toBe(true);

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(consoleErrors).toEqual([]);
});

test("pointer and keyboard movement update relationship-derived connectors", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/format");

  const canvas = page.locator(formatCanvas);
  const advancement = page.getByRole("img", { name: "Advancement" });
  await expect(advancement).toBeVisible();
  await expect(advancement.locator("path[data-connection-id]")).toHaveCount(3);

  const semi = canvas.locator('[data-stage-id="semi"]');
  const semiToFinal = advancement.locator('[data-connection-id="semi-to-final"]');
  const beforePointerPath = await semiToFinal.getAttribute("d");
  const beforeX = Number(await semi.getAttribute("data-stage-x"));
  const beforeY = Number(await semi.getAttribute("data-stage-y"));
  const box = await semi.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 48, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => Number(await semi.getAttribute("data-stage-x"))).toBeGreaterThan(beforeX + 90);
  await expect.poll(async () => Number(await semi.getAttribute("data-stage-y"))).toBeGreaterThan(beforeY + 40);
  expect(Number(await semi.getAttribute("data-stage-x"))).toBeLessThan(beforeX + 104);
  expect(Number(await semi.getAttribute("data-stage-y"))).toBeLessThan(beforeY + 56);
  await expect(semiToFinal).not.toHaveAttribute("d", beforePointerPath ?? "");

  const movedBox = await semi.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(movedBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  if (!movedBox || !canvasBox) return;
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 1, canvasBox.y + 1, { steps: 5 });
  await page.mouse.up();
  await expect(semi).toHaveAttribute("data-stage-x", "24");
  await expect(semi).toHaveAttribute("data-stage-y", "24");

  const poolA = canvas.locator('[data-stage-id="pool-a"]');
  const poolAToSemi = advancement.locator('[data-connection-id="pool-a-to-semi"]');
  const beforeKeyboardX = Number(await poolA.getAttribute("data-stage-x"));
  const beforeKeyboardPath = await poolAToSemi.getAttribute("d");
  await poolA.focus();
  await page.keyboard.press("ArrowRight");
  await expect(poolA).toHaveAttribute("data-stage-x", String(beforeKeyboardX + 24));
  await expect(poolAToSemi).not.toHaveAttribute("d", beforeKeyboardPath ?? "");
  await expect(poolA).toBeFocused();
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
  }
  await expect(poolA).toHaveAttribute("data-stage-x", "24");
  await expect(poolA).toHaveAttribute("data-stage-y", "24");

  expect(consoleErrors).toEqual([]);
});

test("small screens retain the click-to-add manual workflow without overflow", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/format");

  await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Placement", exact: true }).click();
  await expect(page.getByRole("button", { name: "5 Placement placement · 4 participants" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(consoleErrors).toEqual([]);
});
