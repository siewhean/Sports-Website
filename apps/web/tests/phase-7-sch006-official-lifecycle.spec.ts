import { test, expect, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Phase7E2EState = {
  apiOrigin: string;
  competitionId: string;
  competitionSlug: string;
  publicCompetitionPath: string;
  scorekeeperPath: string;
  scoredMatchId: string;
  passToken: string;
  organiserCookie: string;
  divisionNames: string[];
  divisionFixtures: Array<{
    divisionId: string;
    divisionName: string;
    matchId: string;
    matchCode: string;
    homeName: string;
    awayName: string;
  }>;
  scheduleRevisionId: string;
  scheduleVersion: number;
  xssCompetitionPath: string;
  xssMaliciousName: string;
  officialId: string;
  officialName: string;
  officialAssignedRole: string;
  officialTargetMatchId: string;
  officialTargetMatchCode: string;
  secondOfficialId: string;
  secondOfficialName: string;
  initialScheduleVersion: number;
  initialPublicEtag: string;
  noSolutionCompetitionId: string;
  noSolutionJobId: string;
  noSolutionMatchId: string;
  noSolutionMatchCode: string;
};

async function readE2EState(): Promise<Phase7E2EState> {
  const statePath = process.env.PHASE7_E2E_STATE_FILE;
  if (!statePath) {
    throw new Error("PHASE7_E2E_STATE_FILE is required for Gate D browser qualification");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Phase 7 E2E state from ${statePath}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Phase 7 E2E state must be a JSON object");
  }

  const state = parsed as Partial<Phase7E2EState>;
  for (const key of [
    "competitionId",
    "apiOrigin",
    "competitionSlug",
    "publicCompetitionPath",
    "organiserCookie",
    "officialId",
    "officialName",
    "officialAssignedRole",
    "officialTargetMatchId",
    "officialTargetMatchCode",
    "secondOfficialId",
    "secondOfficialName",
    "noSolutionCompetitionId",
    "noSolutionJobId",
    "noSolutionMatchId",
    "noSolutionMatchCode",
  ] as const) {
    if (typeof state[key] !== "string" || state[key]!.length === 0) {
      throw new Error(`Phase 7 E2E state is missing required field ${key}`);
    }
  }

  return state as Phase7E2EState;
}

async function authenticateOrganiser(context: BrowserContext, cookieHeader: string) {
  const [, organiserCookie] = cookieHeader.split("=", 2);
  if (!organiserCookie) throw new Error("Phase 7 organiser cookie is malformed");
  await context.addCookies([
    {
      name: "matchday_session",
      value: organiserCookie,
      url: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3107",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test.describe("SCH-006 Real Stack End-to-End Integration & Operational Certification", () => {
  test("proves official lifecycle, schedule staleness, public truth invariance, regeneration, and S2 publication", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await installConsoleGuard(page);
    const state = await readE2EState();

    await authenticateOrganiser(context, state.organiserCookie);

    // 1. Organiser reads official on Officials page (CP 7.5)
    await page.goto(`/organiser/competitions/${state.competitionId}/officials`);
    await dismissConsent(page);
    await expect(page.getByRole("heading", { name: "Active officials" })).toBeVisible();
    await expect(page.getByText(state.officialName).first()).toBeVisible();
    await expect(page.getByText("Referee").first()).toBeVisible();

    // 2. Schedule read integration: MatchInspector shows official, role, manage link (CP 7.6)
    await page.goto(
      `/organiser/competitions/${state.competitionId}/schedule?match=${encodeURIComponent(state.officialTargetMatchId)}`,
    );
    await dismissConsent(page);
    await expect(page.getByTestId("phase4-schedule")).toBeVisible();
    const assignedOfficialItem = page.locator('[data-testid="schedule-assigned-official"]').first();
    await expect(assignedOfficialItem).toBeVisible();
    await expect(assignedOfficialItem).toContainText(state.officialName);
    await expect(assignedOfficialItem).toContainText(state.officialAssignedRole);

    const manageOfficialsLink = page.getByRole("link", { name: /manage officials/i });
    await expect(manageOfficialsLink).toBeVisible();
    const manageHref = await manageOfficialsLink.getAttribute("href");
    expect(manageHref).toContain(`/officials?match=${encodeURIComponent(state.officialTargetMatchId)}`);

    // Freshness is current before mutation -> no freshness warning
    await expect(page.locator('[data-testid="stale-schedule-warning"]')).toBeHidden();

    // Capture public truth before mutation (CP 7.7)
    const publicBeforeMutation = await context.request.get(
      `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`,
      { headers: { accept: "application/json" } },
    );
    expect(publicBeforeMutation.status()).toBe(200);
    const preMutationEtag = publicBeforeMutation.headers()["etag"]!;
    const preMutationVersion = publicBeforeMutation.headers()["x-matchday-schedule-version"]!;
    const preMutationBody = await publicBeforeMutation.text();

    // 3. Navigate via real Manage officials link (Req 2)
    await manageOfficialsLink.click();
    await dismissConsent(page);
    await expect(page).toHaveURL(new RegExp(`/officials\\?match=${encodeURIComponent(state.officialTargetMatchId)}`));

    // Select Gate D Referee in roster
    await page.getByRole("button", { name: new RegExp(state.officialName, "i") }).click();

    // Open actual Edit availability action
    await page.getByRole("button", { name: "Edit availability" }).click();
    await expect(
      page.getByRole("heading", { name: new RegExp(`Edit availability.*${state.officialName}`, "i") }),
    ).toBeVisible();

    // Modify availability via rendered date/time controls in competition civil time (Asia/Singapore)
    await page.getByRole("button", { name: "Add availability window" }).click();
    await page.getByLabel("Start date").nth(1).fill("2026-09-03");
    await page.getByLabel("Start time").nth(1).fill("08:00");
    await page.getByLabel("End date").nth(1).fill("2026-09-03");
    await page.getByLabel("End time").nth(1).fill("18:00");

    // Submit using actual editor Save action & observe response
    const availabilitySavePromise = page.waitForResponse(
      (res) => res.url().includes("/availability") && res.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save availability" }).click();
    const availRes = await availabilitySavePromise;
    expect(availRes.status()).toBe(200);
    const availJson = (await availRes.json()) as { bumped_revision: boolean };
    expect(availJson.bumped_revision).toBe(true);

    // 4. Assert browser-visible evidence that mutation succeeded and canonical refresh completed (Req 3)
    await expect(
      page.getByRole("heading", { name: new RegExp(`Edit availability.*${state.officialName}`, "i") }),
    ).toBeHidden();
    await expect(page.getByText("Availability saved.")).toBeVisible();
    await expect(page.getByText("2 windows").first()).toBeVisible();
    await expect(page.getByText(/could not be refreshed/i)).toBeHidden();

    // Assert public truth invariance before regeneration (If-None-Match conditional request) (Req 4 / CP 7.7)
    const publicConditional = await context.request.get(
      `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`,
      {
        headers: {
          "if-none-match": preMutationEtag,
          accept: "application/json",
        },
      },
    );
    expect(publicConditional.status()).toBe(304);

    const publicDirect = await context.request.get(
      `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`,
      { headers: { accept: "application/json" } },
    );
    expect(publicDirect.status()).toBe(200);
    expect(publicDirect.headers()["etag"]).toBe(preMutationEtag);
    expect(publicDirect.headers()["x-matchday-schedule-version"]).toBe(preMutationVersion);
    expect(await publicDirect.text()).toBe(preMutationBody);

    // 5. Navigate to Schedule and assert authoritative state (Req 3 / CP 7.6 / CP 7.7)
    await page.goto(`/organiser/competitions/${state.competitionId}/schedule`);
    await dismissConsent(page);
    await expect(page.locator('[data-testid="stale-schedule-warning"]')).toBeVisible();
    await expect(page.getByText("Schedule inputs changed", { exact: false }).first()).toBeVisible();

    // Move match unavailable
    await expect(page.getByRole("link", { name: "Move match" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Move match" })).toBeHidden();

    // Publish disabled
    const publishButton = page.getByRole("button", { name: "Publish schedule" });
    await expect(publishButton).toBeDisabled();

    // Generate schedule enabled
    const generateBtn = page.getByRole("button", { name: /generate/i }).first();
    await expect(generateBtn).toBeEnabled();

    // 6. Real browser regeneration reaching worker (CP 7.8)
    await generateBtn.click();
    const useButton = page.getByRole("button", { name: /use/i }).first();
    await expect(useButton).toBeVisible({ timeout: 60_000 });
    await useButton.click();

    // Workspace accepts candidate and returns to current
    await expect(page.locator('[data-testid="stale-schedule-warning"]')).toBeHidden({ timeout: 15_000 });
    await expect(publishButton).toBeEnabled();

    // 7. Publish S2 via Schedule UI (CP 7.9)
    const publishResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/publish") && response.request().method() === "POST",
    );
    await publishButton.click();
    const publishResponse = await publishResponsePromise;
    expect(publishResponse.status()).toBe(200);
    await expect(page.getByText(/schedule published/i)).toBeVisible();

    // 8. Public projection advances to S2 with new ETag (CP 7.7 / CP 7.9)
    const publicAfterS2 = await context.request.get(
      `${state.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(state.competitionSlug)}/current`,
      {
        headers: {
          "if-none-match": preMutationEtag,
          accept: "application/json",
        },
      },
    );
    expect(publicAfterS2.status()).toBe(200);
    expect(publicAfterS2.headers()["etag"]).not.toBe(preMutationEtag);
    expect(publicAfterS2.headers()["x-matchday-schedule-version"]).toBe(String(Number(preMutationVersion) + 1));
  });

  test("proves match assignment membership change bumps revision while role-only change is neutral", async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    await installConsoleGuard(page);
    const state = await readE2EState();

    await authenticateOrganiser(context, state.organiserCookie);

    // Navigate to officials page with target match selected (Req 6)
    await page.goto(
      `/organiser/competitions/${state.competitionId}/officials?match=${encodeURIComponent(state.officialTargetMatchId)}`,
    );
    await dismissConsent(page);

    // 1. Real Role-Only UI Control: Open Edit match officials (Req 6)
    await page.getByRole("button", { name: "Edit match officials" }).click();

    // Keep official membership identical. Change only the first official's assigned role: Lead official -> First Referee
    const roleInput = page.locator(`#match-role-${state.officialId}`);
    await roleInput.fill("First Referee");

    // Save through the visible UI and observe response
    const roleOnlyResponsePromise = page.waitForResponse(
      (res) => res.url().includes("/officials") && res.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save assignments" }).click();
    const roleOnlyRes = await roleOnlyResponsePromise;
    expect(roleOnlyRes.status()).toBe(200);
    const roleOnlyJson = (await roleOnlyRes.json()) as { bumped_revision: boolean };
    expect(roleOnlyJson.bumped_revision).toBe(false);

    await expect(page.getByText("Match officials saved.")).toBeVisible();

    // Assert Schedule remains current: no stale-schedule-warning, Move remains available
    await page.goto(
      `/organiser/competitions/${state.competitionId}/schedule?match=${encodeURIComponent(state.officialTargetMatchId)}`,
    );
    await dismissConsent(page);
    await expect(page.locator('[data-testid="stale-schedule-warning"]')).toBeHidden();
    await expect(page.getByRole("link", { name: "Move match" })).toBeVisible();

    // 2. Real Membership UI Mutation: Reopen Edit match officials (Req 7)
    await page.goto(
      `/organiser/competitions/${state.competitionId}/officials?match=${encodeURIComponent(state.officialTargetMatchId)}`,
    );
    await dismissConsent(page);
    await page.getByRole("button", { name: "Edit match officials" }).click();

    // Add Second Referee while retaining original official
    const secondCheckbox = page.locator(`#match-official-${state.secondOfficialId}`);
    await secondCheckbox.check();
    const secondRoleInput = page.locator(`#match-role-${state.secondOfficialId}`);
    await secondRoleInput.fill("Second Referee");

    // Save through the visible UI and observe response
    const membershipResponsePromise = page.waitForResponse(
      (res) => res.url().includes("/officials") && res.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save assignments" }).click();
    const membershipRes = await membershipResponsePromise;
    expect(membershipRes.status()).toBe(200);
    const membershipJson = (await membershipRes.json()) as { bumped_revision: boolean };
    expect(membershipJson.bumped_revision).toBe(true);

    await expect(page.getByText("Match officials saved.")).toBeVisible();

    // Navigate to Schedule and assert stale-schedule-warning visible (Req 7)
    await page.goto(`/organiser/competitions/${state.competitionId}/schedule`);
    await dismissConsent(page);
    await expect(page.locator('[data-testid="stale-schedule-warning"]')).toBeVisible();
  });

  test("proves real worker no_solution diagnostics display and security rendering", async ({ page, context }) => {
    test.setTimeout(60_000);
    await installConsoleGuard(page);
    const state = await readE2EState();

    await authenticateOrganiser(context, state.organiserCookie);

    await page.goto(`/organiser/competitions/${state.noSolutionCompetitionId}/schedule`);
    await dismissConsent(page);

    const diagContainer = page.locator('[data-testid="no-solution-diagnostics"]');
    await expect(diagContainer).toBeVisible({ timeout: 15_000 });
    await expect(diagContainer).toContainText("Official conflicts detected");
    await expect(diagContainer).toContainText(
      "Matchday detected potential official scheduling conflicts. Resolving these may not guarantee a feasible schedule if other constraints are also tight.",
    );
    await expect(diagContainer).toContainText(state.noSolutionMatchCode);

    const reviewLink = diagContainer.getByRole("link", { name: "Review officials" });
    await expect(reviewLink).toBeVisible();
    const reviewHref = await reviewLink.getAttribute("href");
    expect(reviewHref).toContain(`/officials?match=${encodeURIComponent(state.noSolutionMatchId)}`);

    // Verify zero raw UUID leaks in diagnostics container (CP 7.23)
    const visibleText = await diagContainer.innerText();
    expect(visibleText).not.toContain(state.noSolutionMatchId);
    expect(visibleText).not.toContain(state.noSolutionJobId);
    expect(visibleText).not.toContain("input_snapshot");
    expect(visibleText).not.toContain("stack");
  });
});
