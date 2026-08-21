#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export function getExactHeadSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Failed to get git HEAD SHA: ${error.message}`);
  }
}

export function getRemoteBranchSha(branchName = "origin/integration/gate-c-final") {
  try {
    return execSync(`git rev-parse ${branchName}`, { cwd: rootDir, encoding: "utf8" }).trim();
  } catch (error) {
    return null;
  }
}

export function isValidCommit(sha) {
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, { cwd: rootDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isAncestor(ancestorSha, descendantSha) {
  try {
    execSync(`git merge-base --is-ancestor ${ancestorSha} ${descendantSha}`, { cwd: rootDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function validateExactShaCertification(options = {}) {
  const allowHistorical = options.allowHistorical ?? false;
  const qaDir = options.qaDir || path.join(rootDir, "docs", "qa");
  const headSha = getExactHeadSha();
  const remoteSha = options.remoteSha ?? getRemoteBranchSha();

  const errors = [];
  const warnings = [];

  // 1. Candidate release record
  const candidateReleasePath = path.join(qaDir, "candidate-release.json");
  let candidateSha = options.targetSha;

  if (fs.existsSync(candidateReleasePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(candidateReleasePath, "utf8"));
      if (!candidateSha) {
        candidateSha = data.candidateSha;
      } else if (data.candidateSha !== candidateSha) {
        errors.push(
          `candidate-release.json candidateSha (${data.candidateSha}) does not match target SHA (${candidateSha}).`,
        );
      }
      if (data.verdict === "PASS" && data.status !== "CERTIFIED") {
        errors.push(`candidate-release.json verdict is PASS but status is not CERTIFIED (${data.status}).`);
      }
    } catch (err) {
      errors.push(`Failed to parse candidate-release.json: ${err.message}`);
    }
  } else {
    warnings.push("candidate-release.json does not exist.");
  }

  const targetSha = candidateSha || headSha;

  // 2. Commit Existence & Ancestry
  if (!isValidCommit(targetSha)) {
    errors.push(`Target SHA (${targetSha}) is not a valid commit in the repository.`);
  }

  // 3. Branch Head Integrity check
  if (!allowHistorical && remoteSha) {
    if (targetSha !== headSha && targetSha !== remoteSha && !isAncestor(targetSha, remoteSha)) {
      errors.push(`Candidate SHA (${targetSha}) is not on integration/gate-c-final branch history (${remoteSha}).`);
    }
    if (headSha !== remoteSha) {
      errors.push(`Local HEAD (${headSha}) is not in sync with remote origin/integration/gate-c-final (${remoteSha}).`);
    }
  }

  // 4. Evidence JSON files check
  const evidenceFiles = [
    "gate-c-c3-final-evidence.json",
    "gate-c-c5-final-evidence.json",
    "gate-c-final-evidence.json",
  ];

  for (const filename of evidenceFiles) {
    const filePath = path.join(qaDir, filename);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const fileSha = data.source_sha || data.candidate_sha;
        if (!fileSha) {
          errors.push(`${filename} is missing source_sha / candidate_sha.`);
        } else if (fileSha !== targetSha) {
          errors.push(`${filename} SHA (${fileSha}) does not match target SHA (${targetSha}).`);
        }

        // Check required provenance metadata
        if (!data.collected_at && !data.certified_at) {
          errors.push(`${filename} is missing collected_at / certified_at timestamp.`);
        }
        if (!data.environment) {
          errors.push(`${filename} is missing environment metadata.`);
        }
      } catch (err) {
        errors.push(`Failed to parse ${filename}: ${err.message}`);
      }
    }
  }

  // 5. Markdown Verdict files check
  const verdictFiles = ["gate-c-c3-verdict.md", "gate-c-c5-verdict.md", "gate-c-verdict.md"];

  for (const filename of verdictFiles) {
    const filePath = path.join(qaDir, filename);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (!content.includes(targetSha)) {
        errors.push(`${filename} does not contain exact target SHA (${targetSha}).`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    targetSha,
    remoteSha,
    errors,
    warnings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowHistorical = args.includes("--allow-historical") || args.includes("--allow-local");
  const targetSha = args.find((a) => a.startsWith("--sha="))?.split("=")[1];

  const result = validateExactShaCertification({ allowHistorical, targetSha });
  if (!result.valid) {
    console.error("❌ Exact-SHA Certification Validation FAILED:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  } else {
    console.log(`✅ Exact-SHA Certification Validation PASSED for candidate SHA: ${result.targetSha}`);
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.warn(`  ⚠️ ${warning}`);
      }
    }
    process.exit(0);
  }
}
