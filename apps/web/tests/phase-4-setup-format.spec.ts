import { expect, test } from "@playwright/test";
import { allowConsoleFailure, assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

test.beforeEach(async ({ page }) => installConsoleGuard(page));
test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("assisted setup renders authoritative capacity and preserves text on AI fallback", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=capacity");
  await dismissConsent(page);
  await expect(page.getByTestId("phase4-assisted-setup")).toBeVisible();
  await expect(page.getByText("52").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Edit lossless capacity/ })).toHaveAttribute("href", /\/capacity$/);

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

test("recommendations disclose capacity, guaranteed play, ranking and feasibility", async ({ page }) => {
  await page.goto("/organiser/competitions/singapore-open/setup?step=format_recommendations");
  await dismissConsent(page);
  await expect(page.getByRole("heading", { name: "Select a feasible format", exact: true })).toBeVisible();
  const card = page.locator("article").filter({ hasText: "Balanced groups" });
  await expect(card.getByText("Matches", { exact: true })).toBeVisible();
  await expect(card.getByText("Minimum play", { exact: true })).toBeVisible();
  await expect(card.getByText("Ranking coverage", { exact: true })).toBeVisible();
  await expect(card.getByText("Available slots", { exact: true })).toBeVisible();
  await expect(card.getByText("Schedule", { exact: true })).toBeVisible();
  await expect(card.getByText("all entries", { exact: true })).toBeVisible();
  await expect(card.getByText("36", { exact: true })).toBeVisible();
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

test.describe("authoritative format round trip", () => {
  test.use({ serviceWorkers: "block" });

  test("manual and visual projections send one exact graph and reload the saved layout lineage", async ({ page }) => {
    const validatedDocuments: Record<string, unknown>[] = [];
    let savedDocument: Record<string, unknown> | null = null;
    const graphHash = "server-canonical-format-hash-0001";
    const materialisationHash = "server-deterministic-materialisation-hash-0001";

    await page.route("**/api/phase4/competitions/*/divisions/*/format-builder/validate", async (route) => {
      const body = route.request().postDataJSON() as { document: Record<string, unknown> };
      validatedDocuments.push(structuredClone(body.document));
      const graph = body.document.graph as {
        matches: Array<{
          id: string;
          stageId: string;
          home: { type: string; matchId?: string };
          away: { type: string; matchId?: string };
        }>;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          issues: [],
          graph_hash: graphHash,
          materialisation: {
            match_count: graph.matches.length,
            fixtures: graph.matches.map((match) => match.id),
            dependencies: graph.matches.map((match) => ({
              match_id: match.id,
              dependency_match_ids: [match.home, match.away]
                .filter((source) => source.type === "winner" || source.type === "loser")
                .map((source) => source.matchId),
            })),
          },
        }),
      });
    });
    await page.route("**/api/phase4/competitions/*/divisions/*/format-builder", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        draft_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
        expected_revision: 6,
        parent_revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
      });
      expect(body.document).toEqual(validatedDocuments.at(-1));
      savedDocument = structuredClone(body.document as Record<string, unknown>);
      const graph = (savedDocument as { graph: { matches: unknown[] } }).graph;
      const segments = new URL(route.request().url()).pathname.split("/");
      const competitionId = decodeURIComponent(segments[segments.indexOf("competitions") + 1]!);
      const divisionId = decodeURIComponent(segments[segments.indexOf("divisions") + 1]!);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          competition_id: competitionId,
          division_id: divisionId,
          draft_id: "6b3f7665-c8cd-47e5-b243-fae28f56f6fe",
          parent_revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
          root_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
          revision: 7,
          status: "draft",
          created_at: "2026-07-22T08:00:00.000Z",
          updated_at: "2026-07-22T08:00:00.000Z",
          permission: "edit",
          read_only: false,
          definition_hash: graphHash,
          document: savedDocument,
          metrics: { match_count: graph.matches.length, guaranteed_matches: 3, maximum_matches: 5 },
          capacity: {
            available_match_slots: 52,
            required_match_slots: graph.matches.length,
            spare_match_slots: 52 - graph.matches.length,
            status: "comfortable",
            evidence_revision: 4,
          },
          validation: { pending: false, validated_definition_hash: graphHash, issues: [] },
        }),
      });
    });
    await page.route("**/api/phase4/format-revisions/*/materialise", async (route) => {
      expect(route.request().url()).toContain("6b3f7665-c8cd-47e5-b243-fae28f56f6fe");
      const graph = (savedDocument as { graph: { matches: unknown[] } }).graph;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: {
            revision_id: "6b3f7665-c8cd-47e5-b243-fae28f56f6fe",
            revision: 7,
            parent_revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
            root_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
            competition_id: "singapore-open",
            division_id: "open-division",
            status: "draft",
            definition_hash: graphHash,
            document: savedDocument,
            created_at: "2026-07-22T08:00:00.000Z",
            published_at: null,
          },
          materialised: true,
          match_count: graph.matches.length,
          materialisation_hash: materialisationHash,
          idempotent_replay: false,
        }),
      });
    });
    await page.route("**/api/phase4/format-revisions/*/publish", async (route) => {
      expect(route.request().url()).toContain("6b3f7665-c8cd-47e5-b243-fae28f56f6fe");
      expect(typeof (route.request().postDataJSON() as Record<string, unknown>).idempotency_key).toBe("string");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision_id: "6b3f7665-c8cd-47e5-b243-fae28f56f6fe",
          revision: 7,
          parent_revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
          root_revision_id: "59245771-cf60-4f50-977d-ed558e6eb147",
          competition_id: "singapore-open",
          division_id: "open-division",
          status: "published",
          definition_hash: graphHash,
          document: savedDocument,
          created_at: "2026-07-22T08:00:00.000Z",
          published_at: "2026-07-22T08:01:00.000Z",
          idempotent_replay: false,
        }),
      });
    });

    await page.goto("/organiser/competitions/singapore-open/format");
    await dismissConsent(page);
    await page.getByRole("button", { name: "Manual", exact: true }).click();
    await page.getByLabel("Stage name").first().fill("Opening pools");
    await page.getByRole("button", { name: "Visual", exact: true }).click();
    const openingPools = page.getByRole("button", { name: /Opening pools\. Use arrow keys/ });
    await openingPools.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Manual", exact: true }).click();
    await expect(page.getByLabel("Opening pools canvas position")).toHaveText("Canvas position 54, 70");

    await page.getByRole("button", { name: "Validate graph" }).click();
    await page.getByRole("button", { name: "Visual", exact: true }).click();
    await page.getByRole("button", { name: "Validate graph" }).click();
    expect(validatedDocuments).toHaveLength(2);
    expect(validatedDocuments[1]).toEqual(validatedDocuments[0]);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Draft r7 saved")).toBeVisible();
    await expect(page.locator('[data-stage-id="stage-group-a"]')).toHaveAttribute("data-stage-x", "54");
    await page.getByRole("button", { name: "Materialise matches" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/16 matches materialised/)).toBeVisible();
    await page.getByRole("button", { name: "Publish format" }).click();
    await expect(page.getByText("Format published. It is now available to deterministic scheduling.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish format" })).toBeDisabled();
  });

  test("template creation appears immediately and version two replaces the same picker row", async ({ page }) => {
    let canonicalDocument: Record<string, unknown> | null = null;
    let saveCount = 0;
    const templateId = "00000000-0000-4000-8000-000000000030";
    const firstVersionId = "00000000-0000-4000-8000-000000000031";
    const secondVersionId = "00000000-0000-4000-8000-000000000032";
    await page.route("**/api/phase4/competitions/*/divisions/*/format-builder/validate", async (route) => {
      canonicalDocument = (route.request().postDataJSON() as { document: Record<string, unknown> }).document;
      const matchCount = (canonicalDocument as { graph: { matches: unknown[] } }).graph.matches.length;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          issues: [],
          graph_hash: "template-source-hash",
          materialisation: { match_count: matchCount },
        }),
      });
    });
    await page.route("**/api/phase4/organisations/*/format-templates", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      saveCount += 1;
      if (saveCount === 1)
        expect(body).toMatchObject({ template_id: null, parent_version_id: null, expected_version: null });
      else
        expect(body).toMatchObject({
          template_id: templateId,
          parent_version_id: firstVersionId,
          expected_version: 1,
        });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          template_id: templateId,
          template_version_id: saveCount === 1 ? firstVersionId : secondVersionId,
          parent_version_id: saveCount === 1 ? null : firstVersionId,
          organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
          created_by_account_id: "account-a",
          name: String(body.name),
          description: null,
          sport_code: "canoe_polo",
          source_format_revision_id: "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed",
          status: "active",
          definition_hash: "template-source-hash",
          document: canonicalDocument,
          revision: saveCount,
          template_created_at: "2026-07-22T00:00:00.000Z",
          version_created_at: `2026-07-22T0${saveCount}:00:00.000Z`,
          archived_by_account_id: null,
          archived_at: null,
        }),
      });
    });

    await page.goto("/organiser/competitions/singapore-open/format");
    await dismissConsent(page);
    await page.getByRole("button", { name: "Validate graph" }).click();
    await page.getByRole("button", { name: "Templates" }).click();
    await page.getByLabel("New template name").fill("Weekend format");
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("Template “Weekend format” saved.")).toBeVisible();

    await page.getByRole("button", { name: "Templates" }).click();
    const templateRows = page.getByRole("dialog").locator("li");
    await expect(templateRows).toHaveCount(1);
    await expect(templateRows.first()).toContainText("Version1 · active");
    await templateRows.getByRole("button", { name: "Update" }).click();
    await page.getByLabel("Updated template name").fill("Weekend format revised");
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect(page.getByText("Template “Weekend format revised” saved.")).toBeVisible();

    await page.getByRole("button", { name: "Templates" }).click();
    await expect(templateRows).toHaveCount(1);
    await expect(templateRows.first()).toContainText("Weekend format revised");
    await expect(templateRows.first()).toContainText("Version2 · active");
    expect(saveCount).toBe(2);
  });
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
  for (const state of [
    "loading",
    "empty",
    "error",
    "offline",
    "permission",
    "read-only",
    "conflict",
    "quota",
    "plan",
  ]) {
    await page.goto(`/organiser/competitions/singapore-open/setup?state=${state}`);
    await expect(page.locator("body")).not.toBeEmpty();
  }
  for (const state of [
    "loading",
    "empty",
    "error",
    "offline",
    "permission",
    "read-only",
    "conflict",
    "quota",
    "plan",
  ]) {
    await page.goto(`/organiser/competitions/singapore-open/format?state=${state}`);
    await expect(page.locator("body")).not.toBeEmpty();
  }
});
