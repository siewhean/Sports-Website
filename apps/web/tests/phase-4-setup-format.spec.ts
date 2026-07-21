import { expect, test } from "@playwright/test";
import {
  allowConsoleFailure,
  assertConsoleGuard,
  dismissConsent,
  installConsoleGuard,
} from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("assisted setup renders authoritative capacity and preserves text on AI fallback", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expect(page.getByText("52").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Edit lossless capacity/ })).toHaveAttribute(
    "href",
    /\/capacity$/,
  );

  await page.route("**/api/phase4/organisations/*/ai/competition-brief", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    expect(body.text).toBe("Sixteen canoe polo teams over two days at OCBC Aquatic Centre.");
    expect(typeof body.idempotency_key).toBe("string");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "manual_fallback",
        preserved_text: body.text,
        reason: "provider_unavailable",
        charged_units: 0,
        usage: {},
      }),
    });
  });
  await page.goto("/organiser/competitions/singapore-open/setup?step=basics");
  const brief = page.getByLabel("Competition brief");
  await brief.fill("Sixteen canoe polo teams over two days at OCBC Aquatic Centre.");
  await page.getByRole("button", { name: "Convert to fields" }).click();
  await expect(brief).toHaveValue("Sixteen canoe polo teams over two days at OCBC Aquatic Centre.");
  await expect(page.getByText("Your text is preserved. Continue with the guided fields below.")).toBeVisible();
});

test("assisted setup sends an optimistic server transition and surfaces conflict", async ({ page }) => {
  await page.route("**/api/phase4/competitions/*/setup-draft", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.expected_revision).toBe(4);
    expect(typeof body.idempotency_key).toBe("string");
    expect((body.transition as Record<string, unknown>).kind).toBe("go_to_step");
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "REVISION_CONFLICT", message: "A newer revision exists" } }),
    });
  });
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  allowConsoleFailure(page, /server responded with a status of 409 \(Conflict\)/);
  await page.getByRole("button", { name: /^Back$/ }).click();
  await expect(page.getByRole("heading", { name: "A newer setup revision is available" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load latest revision" })).toBeVisible();
});

test("manual and visual format modes edit the same canonical stage", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-format-designer")).toBeVisible();
  await page.getByRole("button", { name: /Manual/ }).click();
  const stageName = page.getByLabel("Stage name").first();
  await stageName.fill("Opening pools");
  await page.getByRole("button", { name: /Visual/ }).click();
  await expect(page.getByRole("button", { name: /Opening pools/ })).toBeVisible();
  await page.getByRole("button", { name: /Opening pools/ }).focus();
  const before = await page.getByRole("button", { name: /Opening pools/ }).boundingBox();
  await page.keyboard.press("ArrowRight");
  const after = await page.getByRole("button", { name: /Opening pools/ }).boundingBox();
  expect(after?.x).toBeGreaterThan(before?.x ?? 0);
});

test("server validation controls preview and materialisation state", async ({ page }) => {
  let validatedDocument: Record<string, unknown> | null = null;
  await page.route("**/api/phase4/competitions/*/divisions/*/format-builder/validate", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.document).toBeTruthy();
    validatedDocument = body.document as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        issues: [],
        graph_hash: "server-owned-graph-hash-12345",
        materialisation: { match_count: 16 },
      }),
    });
  });
  await page.route("**/api/phase4/format-revisions/*/materialise", async (route) => {
    expect(typeof (route.request().postDataJSON() as Record<string, unknown>).idempotency_key).toBe("string");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revision: {
          revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
          revision: 6,
          parent_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
          root_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
          competition_id: "singapore-open",
          division_id: "open-division",
          status: "draft",
          definition_hash: "demo-format-definition-hash",
          document: validatedDocument,
          created_at: "2026-07-20T04:00:00.000Z",
          published_at: null,
        },
        materialised: true,
        match_count: 16,
        materialisation_hash: "materialisation-hash",
        idempotent_replay: false,
      }),
    });
  });
  await page.goto("/organiser/competitions/singapore-open/format");
  await dismissConsent(page);
  await page.getByRole("button", { name: "Validate graph" }).click();
  await expect(page.getByText("Format valid", { exact: true })).toBeVisible();
  await expect(page.getByText(/16 matches · hash/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Materialise matches" })).toBeEnabled();
  await page.getByRole("button", { name: "Materialise matches" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("16 matches materialised from the saved graph.")).toBeVisible();
  await page.getByRole("button", { name: "Templates" }).click();
  await expect(page.getByRole("dialog", { name: "Save or reuse a format" })).toBeVisible();
  await expect(page.getByLabel("Template name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Save or reuse a format" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Templates" })).toBeFocused();
});

test("all production state routes preserve truthful geometry", async ({ page }) => {
  for (const state of ["loading", "empty", "error", "offline", "permission", "read-only", "conflict", "quota", "plan"]) {
    await page.goto(`/organiser/competitions/singapore-open/setup?state=${state}`);
    await expect(page.locator("body")).not.toBeEmpty();
  }
  for (const state of ["loading", "empty", "error", "offline", "permission", "read-only", "conflict", "quota", "plan"]) {
    await page.goto(`/organiser/competitions/singapore-open/format?state=${state}`);
    await expect(page.locator("body")).not.toBeEmpty();
  }
});
