#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu;
const SELECTOR_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/iu;

function requireSha(value) {
  if (!value || !SHA_PATTERN.test(value)) throw new Error(`Gate E email audit requires an exact 40-character SHA; got ${value}`);
  return value.toLowerCase();
}

function requireDomain(value) {
  const domain = value?.trim().toLowerCase();
  if (!domain || !DOMAIN_PATTERN.test(domain)) throw new Error(`GATE_E_EMAIL_DOMAIN is invalid: ${value}`);
  return domain;
}

function requireSelector(value) {
  const selector = value?.trim();
  if (!selector || !SELECTOR_PATTERN.test(selector)) throw new Error(`GATE_E_DKIM_SELECTOR is invalid: ${value}`);
  return selector;
}

function flattenTxt(records) {
  return records.map((record) => record.join(""));
}

function findRecord(records, prefix) {
  return records.find((record) => record.toLowerCase().startsWith(prefix.toLowerCase()));
}

function parseTags(record) {
  return Object.fromEntries(
    record
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part.toLowerCase(), ""] : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
      }),
  );
}

export async function runGateEEmailAudit(candidateSha, domainValue, selectorValue, options = {}) {
  const sha = requireSha(candidateSha);
  const domain = requireDomain(domainValue);
  const selector = requireSelector(selectorValue);
  const resolveTxtImpl = options.resolveTxtImpl ?? resolveTxt;
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");

  const [rootTxt, dmarcTxt, dkimTxt] = await Promise.all([
    resolveTxtImpl(domain).then(flattenTxt),
    resolveTxtImpl(`_dmarc.${domain}`).then(flattenTxt),
    resolveTxtImpl(`${selector}._domainkey.${domain}`).then(flattenTxt),
  ]);

  const spf = findRecord(rootTxt, "v=spf1");
  if (!spf) throw new Error(`No SPF record found for ${domain}`);
  if (!/(?:^|\s)[~?+-]all(?:\s|$)/iu.test(spf)) throw new Error("SPF record must contain an explicit all mechanism");

  const dmarc = findRecord(dmarcTxt, "v=DMARC1");
  if (!dmarc) throw new Error(`No DMARC record found for _dmarc.${domain}`);
  const dmarcTags = parseTags(dmarc);
  if (!new Set(["none", "quarantine", "reject"]).has(String(dmarcTags.p).toLowerCase())) {
    throw new Error("DMARC record must declare p=none, quarantine, or reject");
  }

  const dkim = findRecord(dkimTxt, "v=DKIM1");
  if (!dkim) throw new Error(`No DKIM record found for ${selector}._domainkey.${domain}`);
  const dkimTags = parseTags(dkim);
  if (!dkimTags.p || String(dkimTags.p).length < 32) throw new Error("DKIM public key is missing or unexpectedly short");

  const receipt = {
    qa_item: "QA-030",
    evidence_class: "gate_e_automated_only",
    candidate_sha: sha,
    email_domain: domain,
    dkim_selector: selector,
    spf: { status: "PASS", record: spf },
    dmarc: { status: "PASS", policy: dmarcTags.p, record: dmarc },
    dkim: { status: "PASS", key_present: true, record_name: `${selector}._domainkey.${domain}` },
    template_rendering: {
      status: "PASS_VIA_HOSTED_CI_REQUIREMENT",
      evidence: "@matchday/notifications templates-email.test.ts and integration tests must be green in the exact-SHA hosted CI run",
    },
    verdict: "PASS",
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
  const output = { ...receipt, receipt_sha256: receiptSha256 };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-e-email-deliverability.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateEEmailAudit(
    process.argv[2] ?? process.env.CANDIDATE_SHA,
    process.argv[3] ?? process.env.GATE_E_EMAIL_DOMAIN,
    process.argv[4] ?? process.env.GATE_E_DKIM_SELECTOR,
  )
    .then((receipt) => {
      console.log("✓ QA-030 GATE E EMAIL DELIVERABILITY PASS");
      console.log(`  Domain: ${receipt.email_domain}`);
    })
    .catch((error) => {
      console.error(`❌ QA-030 GATE E EMAIL DELIVERABILITY FAIL: ${error.message}`);
      process.exitCode = 1;
    });
}
