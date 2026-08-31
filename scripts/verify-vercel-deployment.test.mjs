import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATCHDAY_GATE_C_BRANCH,
  MATCHDAY_VERCEL_PROJECT_ID,
  MATCHDAY_VERCEL_TEAM_ID,
  verifyVercelDeployment,
} from "./verify-vercel-deployment.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function liveFetch(deployments, buildId = "matchday-build-12345678") {
  return async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.vercel.com/")) {
      return new Response(JSON.stringify({ deployments }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", {
      status: 200,
      headers: { "x-matchday-build-id": buildId },
    });
  };
}

describe("verifyVercelDeployment", () => {
  const dummySha = "1111111111111111111111111111111111111111";
  const artifactDir = path.join(rootDir, "artifacts", "qa", "deployment");
  const artifactPath = path.join(artifactDir, "vercel-response.json");

  afterEach(() => {
    if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);
  });

  it("keeps the Vercel ignore guard schema-safe and fails open to a build", () => {
    const webRoot = path.join(rootDir, "apps", "web");
    const config = JSON.parse(fs.readFileSync(path.join(webRoot, "vercel.json"), "utf8"));
    expect(config.ignoreCommand).toBe("sh scripts/vercel-ignore-build.sh");
    expect(config.ignoreCommand.length).toBeLessThanOrEqual(256);

    const missingPreviousSha = spawnSync("sh", ["scripts/vercel-ignore-build.sh"], {
      cwd: webRoot,
      env: {
        ...process.env,
        VERCEL_GIT_COMMIT_REF: "phase-6/commercial-operations",
        VERCEL_GIT_PREVIOUS_SHA: "0000000000000000000000000000000000000000",
      },
    });
    expect(missingPreviousSha.status).toBe(1);

    const unchangedHead = spawnSync("sh", ["scripts/vercel-ignore-build.sh"], {
      cwd: webRoot,
      env: {
        ...process.env,
        VERCEL_GIT_COMMIT_REF: "phase-6/commercial-operations",
        VERCEL_GIT_PREVIOUS_SHA: "HEAD",
      },
    });
    expect(unchangedHead.status).toBe(0);
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
      url: "https://candidate.example.vercel.app",
      git_branch: MATCHDAY_GATE_C_BRANCH,
      git_commit_sha: dummySha,
      environment: "preview",
      state: "READY",
      created_at: "2026-08-21T09:10:00.000Z",
      verified_at: "2026-08-21T09:15:00.000Z",
      verification_mode: "live_api",
      release_eligible: true,
      provider_build_id: "captured-build-12345678",
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
        url: "https://candidate.example.vercel.app",
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
        url: "https://candidate.example.vercel.app",
        git_branch: MATCHDAY_GATE_C_BRANCH,
        state: "BUILDING",
      }),
      "utf8",
    );

    await expect(verifyVercelDeployment({ candidateSha: dummySha })).rejects.toThrow(/READY/);
  });

  it("uses the live API and running-origin build ID as release-eligible evidence", async () => {
    const documentationPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");
    const documentationBefore = fs.readFileSync(documentationPath, "utf8");
    const request = liveFetch([
      {
        uid: "dpl_2222222222222222222222222222",
        url: "candidate.example.vercel.app",
        created: Date.parse("2026-08-21T09:10:00.000Z"),
        readyState: "READY",
        target: null,
        meta: { githubCommitSha: dummySha, githubCommitRef: MATCHDAY_GATE_C_BRANCH },
      },
    ]);
    const result = await verifyVercelDeployment({
      candidateSha: dummySha,
      vercelToken: "test-token",
      fetchImpl: request,
    });
    expect(result.verified).toBe(true);
    expect(result.mode).toBe("live_api");
    expect(result.releaseEligible).toBe(true);
    expect(result.deployment.verification_mode).toBe("live_api");
    expect(result.deployment.project_id).toBe(MATCHDAY_VERCEL_PROJECT_ID);
    expect(result.deployment.team_id).toBe(MATCHDAY_VERCEL_TEAM_ID);
    expect(result.deployment.provider_build_id).toBe("matchday-build-12345678");
    expect(fs.readFileSync(documentationPath, "utf8")).toBe(documentationBefore);
  });

  it("rejects a READY deployment whose running origin has no build provenance", async () => {
    const request = liveFetch(
      [
        {
          uid: "dpl_missingbuild22222222222222222",
          url: "candidate.example.vercel.app",
          created: Date.parse("2026-08-21T09:10:00.000Z"),
          readyState: "READY",
          target: null,
          meta: { githubCommitSha: dummySha, githubCommitRef: MATCHDAY_GATE_C_BRANCH },
        },
      ],
      "bad",
    );
    await expect(
      verifyVercelDeployment({ candidateSha: dummySha, vercelToken: "test-token", fetchImpl: request }),
    ).rejects.toThrow(/X-Matchday-Build-Id/);
  });

  it("prefers a READY exact-SHA deployment over a newer canceled exact-SHA deployment", async () => {
    const request = liveFetch([
      {
        uid: "dpl_canceled111111111111111111111",
        url: "canceled.example.vercel.app",
        created: Date.parse("2026-08-21T09:11:00.000Z"),
        readyState: "CANCELED",
        target: null,
        meta: { githubCommitSha: dummySha, githubCommitRef: MATCHDAY_GATE_C_BRANCH },
      },
      {
        uid: "dpl_ready22222222222222222222222",
        url: "ready.example.vercel.app",
        created: Date.parse("2026-08-21T09:10:00.000Z"),
        readyState: "READY",
        target: null,
        meta: { githubCommitSha: dummySha, githubCommitRef: MATCHDAY_GATE_C_BRANCH },
      },
    ]);
    const result = await verifyVercelDeployment({
      candidateSha: dummySha,
      vercelToken: "test-token",
      fetchImpl: request,
    });
    expect(result.deployment.deployment_id).toBe("dpl_ready22222222222222222222222");
    expect(result.deployment.state).toBe("READY");
  });

  it("can require one explicit live deployment id for deterministic sealing", async () => {
    const request = liveFetch([
      {
        uid: "dpl_ready33333333333333333333333",
        url: "ready-explicit.example.vercel.app",
        created: Date.parse("2026-08-21T09:10:00.000Z"),
        readyState: "READY",
        target: null,
        meta: { githubCommitSha: dummySha, githubCommitRef: MATCHDAY_GATE_C_BRANCH },
      },
    ]);
    const result = await verifyVercelDeployment({
      candidateSha: dummySha,
      deploymentId: "dpl_ready33333333333333333333333",
      vercelToken: "test-token",
      fetchImpl: request,
    });
    expect(result.deployment.deployment_id).toBe("dpl_ready33333333333333333333333");
    expect(result.deployment.state).toBe("READY");
    await expect(
      verifyVercelDeployment({
        candidateSha: dummySha,
        deploymentId: "dpl_missing444444444444444444444",
        vercelToken: "test-token",
        fetchImpl: request,
      }),
    ).rejects.toThrow(/was not found/);
  });
});
