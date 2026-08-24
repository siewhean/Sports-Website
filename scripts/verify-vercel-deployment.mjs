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
const buildIdPattern = /^[A-Za-z0-9._-]{8,128}$/;

function exactHeadSha() {
  return execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
}

function validateHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Vercel deployment URL: ${String(value)}`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error(`Vercel deployment URL must be credential-free HTTPS: ${String(value)}`);
  }
  return url.toString();
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

  const deploymentUrl = validateHttpsUrl(parsed.url);
  return { deploymentId, deploymentUrl, state, branch, projectId, teamId };
}

async function probeProviderBuildId(deploymentUrl, request = fetch) {
  const response = await request(deploymentUrl, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "text/html", "user-agent": "matchday-gate-c-verifier/1" },
    signal: AbortSignal.timeout(15_000),
  });
  const observedUrl = validateHttpsUrl(response.url || deploymentUrl);
  if (new URL(observedUrl).origin !== new URL(deploymentUrl).origin) {
    throw new Error(`Vercel deployment probe redirected to a different origin: ${observedUrl}`);
  }
  if (!response.ok) {
    throw new Error(`Vercel deployment probe returned HTTP ${response.status}`);
  }
  const buildId = response.headers.get("x-matchday-build-id")?.trim();
  if (!buildId || !buildIdPattern.test(buildId)) {
    throw new Error("Vercel deployment did not expose a valid X-Matchday-Build-Id");
  }
  try {
    await response.body?.cancel();
  } catch {
    // The header is the evidence we need; body cancellation is best-effort.
  }
  return buildId;
}

function selectLiveDeployment(deployments, targetSha, requestedDeploymentId) {
  const exact = deployments.filter(
    (candidate) =>
      candidate?.meta?.githubCommitSha === targetSha && candidate?.meta?.githubCommitRef === MATCHDAY_GATE_C_BRANCH,
  );
  if (requestedDeploymentId) {
    const requested = exact.find((candidate) => (candidate?.uid || candidate?.id) === requestedDeploymentId);
    if (!requested) {
      throw new Error(
        `Vercel deployment ${requestedDeploymentId} was not found for ${MATCHDAY_GATE_C_BRANCH} at candidate SHA ${targetSha}`,
      );
    }
    return requested;
  }
  const ready = exact.find((candidate) => (candidate?.readyState || candidate?.state) === "READY");
  return ready ?? exact[0];
}

export async function verifyVercelDeployment(options = {}) {
  const targetSha = options.candidateSha || exactHeadSha();
  if (!shaPattern.test(targetSha)) {
    throw new Error(`Invalid target candidate SHA: ${targetSha}`);
  }

  const requestedDeploymentId = options.deploymentId || process.env.VERCEL_DEPLOYMENT_ID;
  if (requestedDeploymentId && !dplPattern.test(requestedDeploymentId)) {
    throw new Error(`Invalid requested Vercel deployment ID: ${String(requestedDeploymentId)}`);
  }

  const vercelToken = options.vercelToken || process.env.VERCEL_TOKEN || process.env.VERCEL_BEARER_TOKEN;
  const projectId = options.projectId || process.env.VERCEL_PROJECT_ID || MATCHDAY_VERCEL_PROJECT_ID;
  const teamId = options.teamId || process.env.VERCEL_TEAM_ID || MATCHDAY_VERCEL_TEAM_ID;
  const request = options.fetchImpl || fetch;

  if (projectId !== MATCHDAY_VERCEL_PROJECT_ID || teamId !== MATCHDAY_VERCEL_TEAM_ID) {
    throw new Error("Gate C deployment verification must target the configured Matchday Vercel project and team");
  }

  if (vercelToken) {
    const endpoint = new URL("https://api.vercel.com/v6/deployments");
    endpoint.searchParams.set("projectId", projectId);
    endpoint.searchParams.set("teamId", teamId);
    endpoint.searchParams.set("meta-githubCommitSha", targetSha);
    endpoint.searchParams.set("limit", "100");

    const res = await request(endpoint, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });

    if (!res.ok) {
      throw new Error(`Vercel API returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const deployment = selectLiveDeployment(data.deployments || [], targetSha, requestedDeploymentId);
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

    const shape = validateDeploymentShape(normalized, targetSha, { projectId, teamId });
    normalized.provider_build_id = await probeProviderBuildId(shape.deploymentUrl, request);

    const outDir = path.join(rootDir, "artifacts", "qa", "deployment");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "vercel-response.json"), JSON.stringify(normalized, null, 2) + "\n", "utf8");

    return { verified: true, mode: "live_api", releaseEligible: true, deployment: normalized };
  }

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

  if (requestedDeploymentId) {
    const payloadId = parsed.deployment_id || parsed.id || parsed.uid;
    if (payloadId !== requestedDeploymentId) {
      throw new Error(
        `Deployment payload ${String(payloadId)} does not match requested deployment ${requestedDeploymentId}`,
      );
    }
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
  const deploymentId = args.find((a) => a.startsWith("--deployment-id="))?.split("=")[1];
  verifyVercelDeployment({ candidateSha, deploymentId })
    .then((result) => {
      const suffix = result.releaseEligible ? "release-eligible" : "developer-only";
      const build = result.deployment.provider_build_id ? ` build=${result.deployment.provider_build_id}` : "";
      console.log(
        `✅ Vercel deployment verified (${result.mode}, ${suffix}): ${result.deployment.deployment_id} [READY]${build}`,
      );
    })
    .catch((err) => {
      console.error(`❌ Vercel deployment verification failed: ${err.message}`);
      process.exit(1);
    });
}
