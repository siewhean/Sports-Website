import { expect, test, type Page } from "@playwright/test";
import { assertNoWcagAOrAaViolations } from "./helpers/accessibility";
import { dismissConsent } from "./helpers/console-guard";

async function openScorekeeper(page: Page) {
  await page.goto("/score/prototype");
  await dismissConsent(page);
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring offline" }).click();
  await expect(page.getByRole("heading", { name: "Match 12" })).toBeVisible();
}

test("all web responses enforce the foundation security headers", async ({ request }) => {
  for (const route of ["/", "/setup", "/missing"] as const) {
    const response = await request.get(route);
    const headers = response.headers();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    if (response.url().startsWith("https:")) {
      expect(csp).toContain("upgrade-insecure-requests");
      expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    } else {
      expect(csp).not.toContain("upgrade-insecure-requests");
      expect(headers["strict-transport-security"]).toBeUndefined();
    }
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
  }
});

test("Assisted Setup recalculates capacity and preserves an offline draft", async ({ page }) => {
  await page.goto("/setup");
  const isPhone = (page.viewportSize()?.width ?? 1280) < 768;
  if (isPhone) {
    await page.getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByRole("button", { name: "Capacity Available match slots" }).click();
  }
  await page.getByRole("spinbutton", { name: "Playing areas Courts, pitches or fields" }).fill("3");
  await page.getByLabel("Match slot length").selectOption("40");
  await expect(page.getByRole("heading", { name: "79 match slots" })).toBeVisible();
  await page.getByLabel("Playing area 3 availability").selectOption("limited");
  await expect(page.getByRole("heading", { name: "66 match slots" })).toBeVisible();
  await page.getByLabel("Sunday closing time").fill("15:00");
  await expect(page.getByRole("heading", { name: "62 match slots" })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("heading", { name: "63 match slots" })).toBeVisible();

  await page.getByRole("button", { name: "offline" }).click();
  await expect(page.getByText("Offline · draft only")).toBeVisible();
  if (isPhone) {
    for (let step = 0; step < 6; step += 1) {
      await page.getByRole("button", { name: "Continue" }).click();
    }
  } else {
    await page.getByRole("button", { name: "Review & publish Validation and release" }).click();
  }
  await expect(page.getByRole("button", { name: "Publish competition" })).toBeDisabled();
});

test("Assisted Setup exposes all eight steps and recoverable prototype states", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByLabel("Teams or participants")).toBeVisible();
  await expect(page.getByLabel("Divisions")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Estimated Capacity can be planned before entries close." }),
  ).toBeChecked();
  const steps = [
    ["Basics Competition details", "Basics"],
    ["Capacity Available match slots", "Capacity"],
    ["Settings Sport rules", "Settings"],
    ["Entries Teams and divisions", "Entries"],
    ["Preferences Operational priorities", "Preferences"],
    ["Recommendations Format options", "Recommendations"],
    ["Schedule Scheduling approach", "Schedule"],
    ["Review & publish Validation and release", "Review & publish"],
  ] as const;
  for (const [buttonName, heading] of steps) {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "loading" }).click();
  await expect(page.getByRole("status", { name: "Loading setup data" })).toBeVisible();
  await page.getByRole("button", { name: "error" }).click();
  await expect(page.getByRole("main", { name: "Assisted setup" }).getByRole("alert")).toContainText(
    "One item needs attention",
  );
});

test("Format Designer shares state between visual and manual modes and rejects an invalid connection", async ({
  page,
}) => {
  await page.goto("/format");
  const isPhone = (page.viewportSize()?.width ?? 1280) < 768;
  if (isPhone) {
    await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "1 Pool A groups · 4 participants" }).click();
  } else {
    await page.getByRole("button", { name: "Placement", exact: true }).click();
    await expect(page.getByRole("button", { name: "placement Placement 4 in · 2 advance" })).toBeVisible();
    await page.getByRole("button", { name: "Manual", exact: true }).click();
    await expect(page.getByRole("button", { name: "5 Placement placement · 4 participants" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Add valid connection" }).click();
  await expect(page.getByText("Winner → Medal matches")).toBeVisible();
  await page.getByRole("button", { name: "Try invalid connection" }).click();
  await expect(page.getByText("A final cannot feed another group stage.")).toBeVisible();
});

test("Format Designer exposes loading, empty, offline, and concurrent-edit states", async ({ page }) => {
  await page.goto("/format");
  const stateSelect = page.getByLabel("Preview state");
  await stateSelect.selectOption("loading");
  await expect(page.getByRole("status", { name: "Loading format" })).toBeVisible();
  await stateSelect.selectOption("empty");
  await expect(page.getByRole("heading", { name: "No stages yet" })).toBeVisible();
  await stateSelect.selectOption("offline");
  await expect(page.getByText("Offline draft")).toBeVisible();
  await stateSelect.selectOption("conflict");
  await expect(page.getByText("Newer edit detected")).toBeVisible();
});

test("Phone scoring validates access, queues events, and appends reversals", async ({ page }) => {
  await page.goto("/score/prototype");
  await dismissConsent(page);
  await page.getByLabel("Scoring code").fill("WRONG");
  await page.getByRole("button", { name: "Validate access" }).click();
  await expect(page.getByText("That scoring code is not valid for this match.")).toBeVisible();
  await page.getByLabel("Scoring code").fill("POLO-12");
  await page.getByRole("button", { name: "Validate access" }).click();
  await page.getByRole("checkbox", { name: "I am at Match 12 and ready to score this fixture." }).check();
  await page.getByRole("button", { name: "Start scoring offline" }).click();

  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await expect(page.getByLabel("Marina Blue 1")).toBeVisible();
  await expect(page.getByText("Offline · 1 pending")).toBeVisible();
  await page.getByRole("button", { name: "Undo last" }).click();
  await expect(page.getByLabel("Marina Blue 0")).toBeVisible();
  await expect(page.getByText("Reversal · Marina Blue goal")).toBeVisible();
  await expect(page.getByText("Pending sync", { exact: true })).toHaveCount(2);
});

test("Phone scoring acknowledges replay and fences stale events after takeover", async ({ page }) => {
  await openScorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Replay awaiting acknowledgement")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge replay" }).click();
  await expect(page.getByText("Online · acknowledged")).toBeVisible();
  await page.getByRole("button", { name: "Work offline" }).click();
  await page.getByRole("button", { name: "Goal Harbour Gold" }).click();
  await page.getByRole("button", { name: "Simulate active-device conflict" }).click();
  await expect(page.getByText("Another device is the active scorer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Goal Marina Blue" })).toBeDisabled();
  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByRole("button", { name: "Confirm takeover" }).click();
  await expect(page.getByRole("heading", { name: "Reconcile old-generation facts" })).toBeVisible();
  await expect(page.getByText("Reconciliation required")).toBeVisible();
});

test("Offline finalisation remains pending until server acknowledgement", async ({ page }) => {
  await openScorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await page.getByRole("button", { name: "Review final score" }).click();
  await expect(
    page.getByText("Offline finalisation will remain pending_sync until replay is acknowledged."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm finalisation" }).click();
  await expect(page.getByRole("heading", { name: "Finalisation pending sync" })).toBeVisible();
  await expect(page.getByText("The result is saved locally and is not published yet.")).toBeVisible();
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("button", { name: "Acknowledge replay" }).click();
  await expect(page.getByRole("heading", { name: "Result publication acknowledged" })).toBeVisible();
  await page.getByLabel("Correction reason").fill("Verified against the signed match sheet");
  await page.getByRole("button", { name: "+1 Marina Blue" }).click();
  await expect(page.getByRole("heading", { name: "Downstream schedule conflict" })).toBeVisible();
});

for (const route of ["/setup", "/format", "/score/prototype"] as const) {
  test(`@a11y ${route} has no WCAG A or AA automated accessibility violations`, async ({ page }) => {
    await page.goto(route);
    await dismissConsent(page);
    await page.locator('[data-hydrated="true"]').waitFor();
    await assertNoWcagAOrAaViolations(page);
  });
}

test("@a11y live scorekeeper has no WCAG A or AA automated accessibility violations", async ({ page }) => {
  await openScorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await assertNoWcagAOrAaViolations(page);
});

test("known breakpoints do not introduce page overflow", async ({ page }) => {
  for (const route of ["/setup", "/format", "/score/prototype"] as const) {
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth, `${route} at ${width}px`).toBe(dimensions.clientWidth);
    }
  }
});

test("phone scoring reflows at effective 200% and 400% zoom widths", async ({ page }) => {
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openScorekeeper(page);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth, `${width}px effective viewport`).toBe(dimensions.clientWidth);
    const goalButton = page.getByRole("button", { name: "Goal Marina Blue" });
    await expect(goalButton).toBeVisible();
    expect((await goalButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
  }
});

test("capture prototype evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/setup");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("heading", { name: "Basics" })).toBeVisible();
  await page.getByRole("button", { name: "Capacity Available match slots" }).click();
  await expect(page.getByRole("heading", { name: "Capacity" })).toBeVisible();
  await page.screenshot({ path: "test-results/visual/setup-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 768, height: 1200 });
  await expect(page.getByRole("heading", { name: "Capacity" })).toBeVisible();
  await page.screenshot({ path: "test-results/visual/setup-tablet.png", fullPage: false });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/format");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("heading", { name: "Build the path" })).toBeVisible();
  await page.screenshot({ path: "test-results/visual/format-desktop.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await openScorekeeper(page);
  await page.getByRole("button", { name: "Goal Marina Blue" }).click();
  await expect(page.getByLabel("Marina Blue 1")).toBeVisible();
  await page.screenshot({ path: "test-results/visual/score-phone.png", fullPage: true });

  await page.setViewportSize({ width: 1024, height: 1100 });
  await page.goto("/setup");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "loading" }).click();
  await page.screenshot({ path: "test-results/visual/setup-loading.png", fullPage: false });
  await page.getByRole("button", { name: "error" }).click();
  await page.screenshot({ path: "test-results/visual/setup-error.png", fullPage: false });

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/format");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("opacity", "1");
  await page.getByLabel("Preview state").selectOption("empty");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/visual/format-empty.png", fullPage: false });
  await page.getByLabel("Preview state").selectOption("conflict");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/visual/format-conflict.png", fullPage: false });

  await page.setViewportSize({ width: 1024, height: 1100 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/setup");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("transform", "none");
  await page.screenshot({ path: "test-results/visual/setup-reduced-motion.png", fullPage: false });
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
  await page.goto("/setup");
  await page.locator('[data-hydrated="true"]').waitFor();
  await expect(page.locator("#prototype-main")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/visual/setup-high-contrast.png", fullPage: false });
});
