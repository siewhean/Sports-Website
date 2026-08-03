import { appendFile, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { assertConsoleGuard, dismissConsent, installConsoleGuard } from "./helpers/console-guard";

type Seed = {
  apiOrigin: string;
  webOrigin: string;
  organiserCookie: string;
  competitionId: string;
  slug: string;
  correctionTransactionId: string;
  correctedMatchId: string;
  downstreamMatchId: string;
};

type JourneyResult = {
  project: string;
  competitionId: string;
  repairId: string;
  repairRevisionId: string;
  scheduleVersion: number;
  resultVersion: number;
  correctedMatchId: string;
  downstreamMatchId: string;
};

type PublicTruth = {
  freshness: {
    division_id: string;
    schedule_version: number;
    result_version: number;
  };
  divisions: unknown[];
};

async function expectVerifiedPdf(page: Page, path: string): Promise<{ idempotentReplay: string | null }> {
  const receipt = await page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, { method: "POST" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      expectedSha256: response.headers.get("x-matchday-content-sha256"),
      idempotentReplay: response.headers.get("x-matchday-idempotent-replay"),
      magic: new TextDecoder().decode(bytes.slice(0, 5)),
      byteLength: bytes.byteLength,
      sha256,
    };
  }, path);
  expect(receipt.status).toBe(200);
  expect(receipt.contentType).toContain("application/pdf");
  expect(receipt.disposition).toMatch(/^attachment; filename="[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf"$/u);
  expect(receipt.expectedSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(receipt.magic).toBe("%PDF-");
  expect(receipt.byteLength).toBeGreaterThan(0);
  expect(receipt.sha256).toBe(receipt.expectedSha256);
  return { idempotentReplay: receipt.idempotentReplay };
}

async function seed(projectName: string): Promise<Seed> {
  const file = process.env.PHASE4_E2E_STATE_FILE;
  if (!file) throw new Error("PHASE4_E2E_STATE_FILE is required");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { gate_c_c4_projects?: Record<string, Seed> };
  const value = parsed.gate_c_c4_projects?.[projectName];
  if (!value) throw new Error(`No real C4 fixture exists for ${projectName}`);
  return value;
}

test.afterEach(async ({ page }, testInfo) => assertConsoleGuard(page, testInfo));

test("browser publishes a C4 repair through the real BFF and public truth", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await seed(testInfo.project.name);
  await context.addCookies([
    {
      name: "matchday_session",
      value: fixture.organiserCookie.replace(/^matchday_session=/u, ""),
      url: fixture.webOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await installConsoleGuard(page);

  await page.goto(`/organiser/competitions/${fixture.competitionId}/repairs`);
  await dismissConsent(page);
  await expect(page.getByRole("heading", { level: 1, name: "Result repairs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Corrections awaiting analysis" })).toBeVisible();

  const publicCurrentUrl = `${fixture.apiOrigin}/api/v1/public/competitions/${encodeURIComponent(fixture.slug)}/current`;
  const beforeAnalysis = await page.request.get(publicCurrentUrl);
  expect(beforeAnalysis.status()).toBe(200);
  const beforeAnalysisEtag = beforeAnalysis.headers()["etag"];
  expect(beforeAnalysisEtag).toBeTruthy();

  const analyse = page.getByRole("button", { name: "Build affected-match workspace" });
  const analysisResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/competitions/${fixture.competitionId}/repairs`),
  );
  await analyse.click();
  expect((await analysisResponse).status()).toBe(200);
  await expect(page.getByTestId("gate-c-c4-repair-workspace")).toBeVisible();
  await expect(page.getByText("Workspace opened.")).toBeVisible();
  const draftTruth = await page.request.get(publicCurrentUrl);
  expect(draftTruth.status()).toBe(200);
  expect(draftTruth.headers()["etag"]).toBe(beforeAnalysisEtag);

  const decision = page.getByLabel("Organiser decision").first();
  await expect(decision).toBeVisible();
  await expect(decision.locator("option")).toHaveText([
    "—",
    "Keep current participant",
    "Leave protected match unchanged",
  ]);
  await decision.selectOption("keep_current");
  await page.getByLabel("Decision reason").first().fill("Keep the protected match unchanged pending review.");

  const revisionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/revisions"),
  );
  await page.getByRole("button", { name: "Mark ready for publication" }).click();
  expect((await revisionResponse).status()).toBe(201);
  await expect(page.getByText("Repair revision saved.")).toBeVisible();

  const publicationResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/publish"),
  );
  await page.getByRole("button", { name: "Publish repaired schedule" }).click();
  const publication = await publicationResponse;
  expect(publication.status()).toBe(200);
  const receipt = (await publication.json()) as {
    repair_id: string;
    repair_revision_id: string;
    schedule_version: number;
    result_version: number;
  };
  await expect(page.getByText("The repaired schedule is now public.")).toBeVisible();

  const publicTruth = await page.request.get(publicCurrentUrl);
  expect(publicTruth.status()).toBe(200);
  const publicEtag = publicTruth.headers()["etag"];
  expect(publicEtag).toBeTruthy();
  expect(publicEtag).not.toBe(beforeAnalysisEtag);
  expect(publicTruth.headers()["last-modified"]).toBeTruthy();
  expect(publicTruth.headers()["cache-control"]).toBeTruthy();
  const publicPayload = (await publicTruth.json()) as PublicTruth;
  expect(publicPayload.freshness.schedule_version).toBe(receipt.schedule_version);
  expect(publicPayload.freshness.result_version).toBe(receipt.result_version);
  expect(publicPayload.divisions).toHaveLength(2);

  const scopedTruth = await page.request.get(
    `${publicCurrentUrl}?division_id=${encodeURIComponent(publicPayload.freshness.division_id)}`,
  );
  expect(scopedTruth.status()).toBe(200);
  const scopedPayload = (await scopedTruth.json()) as PublicTruth;
  expect(scopedPayload.divisions).toHaveLength(1);
  const scopedEtag = scopedTruth.headers()["etag"];
  expect(scopedEtag).toBeTruthy();
  const notModified = await page.request.get(
    `${publicCurrentUrl}?division_id=${encodeURIComponent(publicPayload.freshness.division_id)}`,
    { headers: { "if-none-match": scopedEtag! } },
  );
  expect(notModified.status()).toBe(304);

  const scheduleExport = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/competitions/${fixture.competitionId}/exports/schedule`),
  );
  await page.getByRole("button", { name: "Download published schedule PDF" }).click();
  expect((await scheduleExport).status()).toBe(200);
  expect(
    (await expectVerifiedPdf(page, `/api/gate-c/competitions/${fixture.competitionId}/exports/schedule`))
      .idempotentReplay,
  ).toBe("true");
  await expectVerifiedPdf(
    page,
    `/api/gate-c/competitions/${fixture.competitionId}/exports/matches/${fixture.correctedMatchId}/score-sheet`,
  );

  const resultFile = process.env.GATE_C_C4_E2E_RESULT_FILE;
  if (!resultFile) throw new Error("GATE_C_C4_E2E_RESULT_FILE is required");
  const result: JourneyResult = {
    project: testInfo.project.name,
    competitionId: fixture.competitionId,
    repairId: receipt.repair_id,
    repairRevisionId: receipt.repair_revision_id,
    scheduleVersion: receipt.schedule_version,
    resultVersion: receipt.result_version,
    correctedMatchId: fixture.correctedMatchId,
    downstreamMatchId: fixture.downstreamMatchId,
  };
  await appendFile(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
});
