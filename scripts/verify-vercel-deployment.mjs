#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export const MATCHDAY_VERCEL_PROJECT_ID = "prj_3y6T5b9aTxy1o6PbpGeK2vGiTkMk";
export const MATCHDAY_VERCEL_TEAM_ID = "team_EqEVvtYJl1XlrsIvRj266qnq";
export const MATCHDAY_GATE_C_BRANCH = "integration/gate-c-final";

const dplPattern = /^dpl_[A-Za-z0-9]+$/;
const shaPattern = /^[a-f0-9]{40}$/;

function exactHeadSha() {
  return execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
}

function validateDeploymentShape(parsed, targetSha, options = {}) {
  const deploymentId = parsed.deployment_id || parsed.id || parsed.uid;
  if (!deploymentId || !dplPattern.test(deploymentId)) {
    throw new Error(`Invalid Vercel deployment ID: ${String(deploymentId)}`);
  }

  const commitSha = parsed.git_commit_sha || parsed.candidate_sha || parsed.meta?.githubCommitSha;
  if (commitSha !== targetSha) {
    throw new Error(`Deployment commit SHA ${String(commitSha)} does not match candidate SHA ${targetSha}`);
  }

  const branch = parsed.git_branch || parsed.meta?.githubCommitRef;
  if (branch !== MATCHDAY_GATE_C_BRANCH) {
    throw new Error(`Deployment Git branch ${String(branch)} does not match ${MATCHDAY_GATE_C_BRANCH}`);
  }

  const state = parsed.state || parsed.readyState;
  if (state !== "READY") {
    throw new Error(`Vercel deployment ${deploymentId} is in state ${String(state)}, expected READY`);
  }

  const projectId = parsed.project_id || options.projectId;
  if (projectId !== MATCHDAY_VERCEL_PROJECT_ID) {
    throw new Error(`Deployment project ${String(projectId)} is not the Matchday Vercel project`);
  }

  const teamId = parsed.team_id || options.teamId;
  if (teamId !== MATCHDAY_VERCEL_TEAM_ID) {
    throw new Error(`Deployment team ${String(teamId)} is not the Matchday Vercel team`);
  }

  return { deploymentId, state, branch, projectId, teamId };
}

export async function verifyVercelDeployment(options = {}) {
  const targetSha = options.candidateSha || exactHeadSha();
  if (!shaPattern.test(targetSha)) {
    throw new Error(`Invalid target candidate SHA: ${targetSha}`);
  }

  const vercelToken = options.vercelToken || process.env.VERCEL_TOKEN || process.env.VERCEL_BEARER_TOKEN;
  const projectId = options.projectId || process.env.VERCEL_PROJECT_ID || MATCHDAY_VERCEL_PROJECT_ID;
  const teamId = options.teamId || process.env.VERCEL_TEAM_ID || MATCHDAY_VERCEL_TEAM_ID;

  if (projectId !== MATCHDAY_VERCEL_PROJECT_ID || teamId !== MATCHDAY_VERCEL_TEAM_ID) {
    throw new Error("Gate C deployment verification must target the configured Matchday Vercel project and team");
  }

  if (vercelToken) {
    const endpoint = new URL("https://api.vercel.com/v6/deployments");
    endpoint.searchParams.set("projectId", projectId);
    endpoint.searchParams.set("teamId", teamId);
    endpoint.searchParams.set("meta-githubCommitSha", targetSha);
    endpoint.searchParams.set("limit", "20");

    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });

    if (!res.ok) {
      throw new Error(`Vercel API returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const deployment = (data.deployments || []).find(
      (candidate) =>
        candidate?.meta?.githubCommitSha === targetSha &&
        candidate?.meta?.githubCommitRef === MATCHDAY_GATE_C_BRANCH,
    );
    if (!deployment) {
      throw new Error(`No Vercel deployment found for ${MATCHDAY_GATE_C_BRANCH} at candidate SHA ${targetSha}`);
    }

    const normalized = {
      schema_version: "gate-c-vercel-deployment-v2",
      candidate_sha: targetSha,
      provider: "vercel",
      project_id: projectId,
      team_id: teamId,
      deployment_id: deployment.uid || deployment.id,
      url: deployment.url ? `https://${deployment.url}` : undefined,
      git_branch: deployment.meta?.githubCommitRef,
      git_commit_sha: deployment.meta?.githubCommitSha,
      environment: deployment.target || "preview",
      state: deployment.readyState || deployment.state,
      created_at: new Date(deployment.created).toISOString(),
      verified_at: new Date().toISOString(),
      verification_mode: "live_api",
      release_eligible: true,
    };

    validateDeploymentShape(normalized, targetSha, { projectId, teamId });

    const outDir = path.join(rootDir, "artifacts", "qa", "deployment");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "vercel-response.json"), JSON.stringify(normalized, null, 2) + "\n", "utf8");

    const docsPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");

    return { verified: true, mode: "live_api", releaseEligible: true, deployment: normalized };
  }

  // Developer-only immutable payload verification. This can establish that a
  // captured response is internally consistent, but it is deliberately not
  // sufficient for Gate C release certification.
  const artifactPath = path.join(rootDir, "artifacts", "qa", "deployment", "vercel-response.json");
  const docsPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");
  const sourceFile = fs.existsSync(artifactPath) ? artifactPath : fs.existsSync(docsPath) ? docsPath : null;
  if (!sourceFile) {
    throw new Error(`No Vercel token supplied and no immutable deployment payload exists at ${artifactPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  } catch {
    throw new Error(`Malformed JSON in deployment payload at ${sourceFile}`);
  }

  validateDeploymentShape(parsed, targetSha, { projectId, teamId });
  return {
    verified: true,
    mode: "artifact_payload",
    releaseEligible: false,
    sourceFile,
    deployment: parsed,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const candidateSha = args.find((a) => a.startsWith("--sha="))?.split("=")[1];
  verifyVercelDeployment({ candidateSha })
    .then((result) => {
      const suffix = result.releaseEligible ? "release-eligible" : "developer-only";
      console.log(
        `✅ Vercel deployment verified (${result.mode}, ${suffix}): ${result.deployment.deployment_id} [READY]`,
      );
    })
    .catch((err) => {
      console.error(`❌ Vercel deployment verification failed: ${err.message}`);
      process.exit(1);
    });
}
