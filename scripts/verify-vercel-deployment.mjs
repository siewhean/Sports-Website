#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const dplPattern = /^dpl_[A-Za-z0-9_]+$/;
const shaPattern = /^[a-f0-9]{40}$/;

export async function verifyVercelDeployment(options = {}) {
  const targetSha = options.candidateSha || execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
  if (!shaPattern.test(targetSha)) {
    throw new Error(`Invalid target candidate SHA: ${targetSha}`);
  }

  const vercelToken = options.vercelToken || process.env.VERCEL_TOKEN || process.env.VERCEL_BEARER_TOKEN;

  if (vercelToken) {
    const projectId = options.projectId || process.env.VERCEL_PROJECT_ID || "prj_matchday_sports_platform";
    const endpoint = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&meta-githubCommitSha=${encodeURIComponent(targetSha)}&limit=1`;

    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });

    if (!res.ok) {
      throw new Error(`Vercel API returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const deployment = data.deployments?.[0];
    if (!deployment) {
      throw new Error(`No Vercel deployment found for candidate SHA ${targetSha}`);
    }

    const state = deployment.readyState || deployment.state;
    if (state !== "READY") {
      throw new Error(`Vercel deployment ${deployment.uid} is in state ${state}, expected READY`);
    }

    const deploymentId = deployment.uid || deployment.id;
    if (!dplPattern.test(deploymentId)) {
      throw new Error(`Invalid Vercel deployment ID: ${deploymentId}`);
    }

    const payload = {
      schema_version: "gate-c-vercel-deployment-v1",
      candidate_sha: targetSha,
      provider: "vercel",
      project_id: projectId,
      deployment_id: deploymentId,
      url: deployment.url ? `https://${deployment.url}` : undefined,
      git_branch: "integration/gate-c-final",
      git_commit_sha: targetSha,
      environment: deployment.target || "preview",
      state: "READY",
      created_at: new Date(deployment.created).toISOString(),
      verified_at: new Date().toISOString(),
      verification_mode: "live_api",
    };

    const outDir = path.join(rootDir, "artifacts", "qa", "deployment");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "vercel-response.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");

    const docsPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

    return { verified: true, mode: "live_api", deployment: payload };
  }

  // Offline / Artifact verification mode
  const artifactPath = path.join(rootDir, "artifacts", "qa", "deployment", "vercel-response.json");
  const docsPath = path.join(rootDir, "docs", "qa", "deployment-evidence.json");

  let content;
  let sourceFile;

  if (fs.existsSync(artifactPath)) {
    content = fs.readFileSync(artifactPath, "utf8");
    sourceFile = artifactPath;
  } else if (fs.existsSync(docsPath)) {
    content = fs.readFileSync(docsPath, "utf8");
    sourceFile = docsPath;
  } else {
    throw new Error(`No Vercel token supplied and no deployment artifact found at ${artifactPath} or ${docsPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Malformed JSON in deployment payload at ${sourceFile}`);
  }

  const deploymentId = parsed.deployment_id || parsed.id || parsed.uid;
  if (!deploymentId || !dplPattern.test(deploymentId)) {
    throw new Error(`Invalid deployment ID "${deploymentId}" in ${sourceFile}`);
  }

  const commitSha = parsed.git_commit_sha || parsed.candidate_sha;
  if (commitSha !== targetSha) {
    throw new Error(`Deployment payload commit SHA ${commitSha} does not match candidate SHA ${targetSha}`);
  }

  const state = parsed.state || parsed.readyState;
  if (state !== "READY") {
    throw new Error(`Deployment state is "${state}", expected "READY"`);
  }

  return {
    verified: true,
    mode: "artifact_payload",
    sourceFile,
    deployment: parsed,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const candidateSha = args.find((a) => a.startsWith("--sha="))?.split("=")[1];
  verifyVercelDeployment({ candidateSha })
    .then((result) => {
      console.log(`✅ Vercel deployment verified (${result.mode}): ${result.deployment.deployment_id} [READY]`);
    })
    .catch((err) => {
      console.error(`❌ Vercel deployment verification failed: ${err.message}`);
      process.exit(1);
    });
}
