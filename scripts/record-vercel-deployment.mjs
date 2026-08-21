#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyVercelDeployment } from "./verify-vercel-deployment.mjs";

export async function recordVercelDeployment(options = {}) {
  const result = await verifyVercelDeployment(options);
  return result.deployment;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const candidateSha = args.find((a) => a.startsWith("--sha="))?.split("=")[1];
  recordVercelDeployment({ candidateSha })
    .then((deployment) => {
      console.log(
        `✅ Verified Vercel deployment evidence for SHA: ${deployment.candidate_sha || deployment.git_commit_sha}`,
      );
    })
    .catch((err) => {
      console.error(`❌ Vercel deployment recording failed: ${err.message}`);
      process.exit(1);
    });
}
