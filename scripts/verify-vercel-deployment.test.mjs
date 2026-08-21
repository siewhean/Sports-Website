import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATCHDAY_GATE_C_BRANCH,
  MATCHDAY_VERCEL_PROJECT_ID,
  MATCHDAY_VERCEL_TEAM_ID,
  verifyVercelDeployment,
} from "./verify-vercel-deployment.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

describe("verifyVercelDeployment", () => {
  const dummySha = "1111111111111111111111111111111111111111";
  const artifactDir = path.join(rootDir, "artifacts", "qa", "deployment");
  const artifactPath = path.join(artifactDir, "vercel-response.json");

  afterEach(() => {
    if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);
  });

  it("fails when no deployment artifact exists and no token is supplied", async () => {
    await expect(
      verifyVercelDeployment({
        candidateSha: "9999999999999999999999999999999999999999",
      }),
    ).rejects.toThrow();
  });

  it("verifies an immutable offline payload but marks it non-release-eligible", async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    const payload = {
      schema_version: "gate-c-vercel-deployment-v2",
      candidate_sha: dummySha,
      provider: "vercel",
      project_id: MATCHDAY_VERCEL_PROJECT_ID,
      team_id: MATCHDAY_VERCEL_TEAM_ID,
      deployment_id: "dpl_1111111111111111111111111111",
      git_branch: MATCHDAY_GATE_C_BRANCH,
      git_commit_sha: dummySha,
      environment: "preview",
      state: "READY",
      created_at: "2026-08-21T09:10:00.000Z",
      verified_at: "2026-08-21T09:15:00.000Z",
      verification_mode: "live_api",
      release_eligible: true,
    };
    fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), "utf8");

    const result = await verifyVercelDeployment({ candidateSha: dummySha });
    expect(result.verified).toBe(true);
    expect(result.mode).toBe("artifact_payload");
    expect(result.releaseEligible).toBe(false);
    expect(result.deployment.state).toBe("READY");
  });

  it("rejects an offline payload for the wrong project", async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({
        candidate_sha: dummySha,
        project_id: "prj_wrong",
        team_id: MATCHDAY_VERCEL_TEAM_ID,
        deployment_id: "dpl_1111111111111111111111111111",
        git_branch: MATCHDAY_GATE_C_BRANCH,
        state: "READY",
      }),
      "utf8",
    );

    await expect(verifyVercelDeployment({ candidateSha: dummySha })).rejects.toThrow(/Matchday Vercel project/);
  });

  it("rejects artifact payload if state is not READY", async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({
        candidate_sha: dummySha,
        project_id: MATCHDAY_VERCEL_PROJECT_ID,
        team_id: MATCHDAY_VERCEL_TEAM_ID,
        deployment_id: "dpl_1111111111111111111111111111",
        git_branch: MATCHDAY_GATE_C_BRANCH,
        state: "BUILDING",
      }),
      "utf8",
    );

    await expect(verifyVercelDeployment({ candidateSha: dummySha })).rejects.toThrow(/READY/);
  });

  it("uses the live API result as release-eligible evidence", async () => {
    const originalFetch = globalThis.fetch;
    const documentationPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");
    const documentationBefore = fs.readFileSync(documentationPath, "utf8");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          deployments: [
            {
              uid: "dpl_2222222222222222222222222222",
              url: "candidate.example.vercel.app",
              created: Date.parse("2026-08-21T09:10:00.000Z"),
              readyState: "READY",
              target: null,
              meta: {
                githubCommitSha: dummySha,
                githubCommitRef: MATCHDAY_GATE_C_BRANCH,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const result = await verifyVercelDeployment({ candidateSha: dummySha, vercelToken: "test-token" });
      expect(result.verified).toBe(true);
      expect(result.mode).toBe("live_api");
      expect(result.releaseEligible).toBe(true);
      expect(result.deployment.verification_mode).toBe("live_api");
      expect(result.deployment.project_id).toBe(MATCHDAY_VERCEL_PROJECT_ID);
      expect(result.deployment.team_id).toBe(MATCHDAY_VERCEL_TEAM_ID);
      expect(fs.readFileSync(documentationPath, "utf8")).toBe(documentationBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
