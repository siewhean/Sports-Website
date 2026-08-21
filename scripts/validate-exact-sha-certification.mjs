#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export const EVIDENCE_ONLY_ALLOWLIST_PATTERNS = [
  /^docs\/qa\//,
  /^artifacts\/qa\//,
  /^fixtures\/physical-device-evidence\//,
  /^scripts\/seal-gate-c-certification\.mjs$/,
  /^scripts\/seal-gate-c-certification\.test\.mjs$/,
  /^scripts\/validate-exact-sha-certification\.mjs$/,
  /^scripts\/validate-exact-sha-certification\.test\.mjs$/,
  /^scripts\/verify-vercel-deployment\.mjs$/,
  /^scripts\/verify-vercel-deployment\.test\.mjs$/,
];

export const REQUIRED_EVIDENCE_FILES = [
  "gate-c-c1-final-evidence.json",
  "gate-c-c2-final-evidence.json",
  "gate-c-c3-final-evidence.json",
  "gate-c-c4-final-evidence.json",
  "gate-c-c5-final-evidence.json",
  "gate-c-final-evidence.json",
];

export const REQUIRED_VERDICT_FILES = [
  "gate-c-c1-verdict.md",
  "gate-c-c2-verdict.md",
  "gate-c-c3-verdict.md",
  "gate-c-c4-verdict.md",
  "gate-c-c5-verdict.md",
  "gate-c-verdict.md",
];

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

export function validatePostCandidateDiff(candidateSha, headSha) {
  if (candidateSha === headSha) return [];
  try {
    const commitsOutput = execSync(`git log --oneline --reverse ${candidateSha}..${headSha}`, {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const commitLines = commitsOutput ? commitsOutput.split("\n").filter(Boolean) : [];
    const disallowed = [];

    for (const commitLine of commitLines) {
      const commitSha = commitLine.split(" ")[0];
      const commitDiff = execSync(`git diff-tree --no-commit-id --name-only -r ${commitSha}`, {
        cwd: rootDir,
        encoding: "utf8",
      }).trim();
      const files = commitDiff.split("\n").filter(Boolean);
      for (const file of files) {
        const allowed = EVIDENCE_ONLY_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(file));
        if (!allowed) {
          disallowed.push(`[${commitLine}] ${file}`);
        }
      }
    }
    return disallowed;
  } catch (err) {
    return [`git diff failed: ${err.message}`];
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
    errors.push("Missing required candidate-release.json artifact.");
  }

  const targetSha = candidateSha || headSha;
  const checkGit = options.checkGit ?? true;

  // 2. Commit Existence & Ancestry
  if (checkGit && !isValidCommit(targetSha)) {
    errors.push(`Target SHA (${targetSha}) is not a valid commit in the repository.`);
  }

  // 3. Branch Head Integrity check & Post-Candidate Diff Allowlist
  if (checkGit && targetSha !== headSha) {
    if (!isAncestor(targetSha, headSha)) {
      errors.push(`Candidate SHA (${targetSha}) is not an ancestor of current HEAD (${headSha}).`);
    } else {
      const disallowedChanges = validatePostCandidateDiff(targetSha, headSha);
      if (disallowedChanges.length > 0) {
        errors.push(
          `Post-candidate commits modified disallowed runtime/application files: ${disallowedChanges.join(", ")}. Post-freeze commits may only touch evidence documents, artifacts, fixtures, or certification scripts.`,
        );
      }
    }
  }

  if (checkGit && !allowHistorical && remoteSha) {
    if (targetSha !== headSha && targetSha !== remoteSha && !isAncestor(targetSha, remoteSha)) {
      errors.push(`Candidate SHA (${targetSha}) is not on integration/gate-c-final branch history (${remoteSha}).`);
    }
    if (headSha !== remoteSha) {
      errors.push(`Local HEAD (${headSha}) is not in sync with remote origin/integration/gate-c-final (${remoteSha}).`);
    }
  }

  // 4. Evidence JSON files check (C1 through C5 + Consolidated)
  for (const filename of REQUIRED_EVIDENCE_FILES) {
    const filePath = path.join(qaDir, filename);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing required final evidence artifact: ${filename}`);
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const fileSha = data.source_sha || data.candidate_sha;
      if (!fileSha) {
        errors.push(`${filename} is missing source_sha / candidate_sha.`);
      } else if (fileSha !== targetSha) {
        errors.push(`${filename} SHA (${fileSha}) does not match target SHA (${targetSha}).`);
      }

      const status = data.status || data.verdict;
      if (status !== "PASS" && status !== "CERTIFIED") {
        errors.push(`${filename} status is not PASS or CERTIFIED (${status}).`);
      }

      if (data.record_status && data.record_status !== "CURRENT_CERTIFICATION") {
        errors.push(`${filename} record_status is not CURRENT_CERTIFICATION (${data.record_status}).`);
      }

      if (data.branch && data.branch !== "integration/gate-c-final") {
        errors.push(
          `${filename} references non-authoritative branch (${data.branch}). Expected integration/gate-c-final.`,
        );
      }

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

  // 5. Markdown Verdict files check (C1 through C5 + Consolidated)
  for (const filename of REQUIRED_VERDICT_FILES) {
    const filePath = path.join(qaDir, filename);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing required final verdict document: ${filename}`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(targetSha)) {
      errors.push(`${filename} does not contain exact target SHA (${targetSha}).`);
    }
    if (!content.includes("PASS") && !content.includes("CERTIFIED")) {
      errors.push(`${filename} does not declare a PASS or CERTIFIED verdict.`);
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
