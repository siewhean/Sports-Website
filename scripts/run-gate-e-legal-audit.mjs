#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

function requireSha(value) {
  if (!value || !SHA_PATTERN.test(value)) throw new Error(`Gate E legal audit requires an exact 40-character SHA; got ${value}`);
  return value.toLowerCase();
}

async function requireSubstantiveFile(relativePath, needles = []) {
  const absolute = path.join(root, relativePath);
  const info = await stat(absolute);
  const text = await readFile(absolute, "utf8");
  if (!info.isFile() || text.trim().length < 200) throw new Error(`${relativePath} is missing or not substantive`);
  for (const needle of needles) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${relativePath} is missing required concept: ${needle}`);
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function runGateELegalAudit(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const files = {
    privacy_page: await requireSubstantiveFile("apps/web/app/privacy/page.tsx", ["privacy"]),
    terms_page: await requireSubstantiveFile("apps/web/app/terms/page.tsx", ["terms"]),
    cookie_page: await requireSubstantiveFile("apps/web/app/cookies/page.tsx", ["cookie"]),
    legal_deferment_adr: await requireSubstantiveFile("docs/decisions/0003-phase6-legal-privacy-approval-gate.md", ["Gate F", "formal authorised legal/privacy approval"]),
  };

  const receipt = {
    qa_item: "QA-027",
    evidence_class: "gate_e_automated_only",
    candidate_sha: sha,
    policy_source_sha256: files,
    automated_legal_privacy_tests: "REQUIRED_BY_HOSTED_CI",
    formal_authorised_legal_approval: "DEFERRED_TO_GATE_F_BY_ADR_0003",
    legal_compliance_claim: "NOT_MADE",
    verdict: "PASS_TECHNICAL_PACKAGE_WITH_GATE_F_DEFERMENT",
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
  const output = { ...receipt, receipt_sha256: receiptSha256 };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-e-legal-package.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateELegalAudit(process.argv[2] ?? process.env.CANDIDATE_SHA)
    .then(() => console.log("✓ QA-027 GATE E LEGAL/POLICY TECHNICAL PACKAGE PASS — FORMAL APPROVAL DEFERRED TO GATE F"))
    .catch((error) => {
      console.error(`❌ QA-027 GATE E LEGAL PACKAGE FAIL: ${error.message}`);
      process.exitCode = 1;
    });
}
