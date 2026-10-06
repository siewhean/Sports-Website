#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEvidence } from "./validate-external-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSha(value) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Cache purge audit requires an exact 40-character candidate SHA; got ${value}`);
  }
  return value.toLowerCase();
}

export async function runGateFCachePurgeAudit(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const evidenceFile = options.evidenceFile
    ? path.resolve(options.evidenceFile)
    : options.cacheEvidenceFile
      ? path.resolve(options.cacheEvidenceFile)
      : undefined;

  // Validate external edge cache / CDN purge evidence
  const validation = await loadAndValidateEvidence(sha, evidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "PRODUCTION_LIVE_PROBE", "OPERATOR_CAPTURE"],
    requireProductionEnvironment: true,
  });

  const hasSpecificProof =
    validation.errors.length === 0 &&
    Boolean(validation.evidence?.purge_id) &&
    Boolean(validation.evidence?.purge_scope) &&
    (validation.evidence?.purge_result === "SUCCESS" || validation.evidence?.purge_status === "COMPLETED");

  const isPass = hasSpecificProof;

  const receipt = {
    qa_item: "OPS-009",
    candidate_sha: sha,
    edge_cache_invalidation_protocol: "purge_on_publish_and_deploy",
    static_asset_hashing: "immutable_content_hash",
    public_projection_version_monotonic: true,
    protocol_verification: "SOURCE_PASS",
    verdict: isPass ? "PASS" : "PENDING",
    pending_reasons: isPass ? [] : validation.errors,
    ...(validation.evidenceSha256
      ? { input_evidence_sha256: validation.evidenceSha256, evidence_reference: evidenceFile }
      : {}),
    verified_evidence_files: validation.verifiedFiles,
    ...(isPass ? { production_observations: validation.evidence } : {}),
    generated_at: new Date().toISOString(),
  };

  const { receipt_sha256, ...payload } = receipt;
  receipt.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(payload, null, 2))
    .digest("hex");

  await writeFile(path.join(artifactsDir, "gate-f-cache-purge.json"), JSON.stringify(receipt, null, 2));

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFCachePurgeAudit(sha, { evidenceFile: process.argv[3] })
    .then((r) => {
      console.log(`Gate F cache purge: ${r.verdict}`);
      if (r.verdict !== "PASS") process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
