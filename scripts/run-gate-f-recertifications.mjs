#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { productionHostname, productionOrigin } from "./lib/hostnames.mjs";
import { loadAndValidateEvidence } from "./validate-external-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSha(value) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Recertifications require an exact 40-character candidate SHA; got ${value}`);
  }
  return value.toLowerCase();
}

export async function runGateFRecertifications(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");

  await mkdir(artifactsDir, { recursive: true });

  // 1. DNS & TLS (OPS-014, Gate F Section 5)
  // Requires PRODUCTION_LIVE_PROBE or PROVIDER_RECEIPT
  const dnsTlsEvidence = await loadAndValidateEvidence(sha, options.dnsTlsEvidenceFile, {
    allowedEvidenceClasses: ["PRODUCTION_LIVE_PROBE", "PROVIDER_RECEIPT"],
    requireProductionEnvironment: true,
    requiredFiles: ["provider_capture"],
  });

  const dnsTlsPassed =
    dnsTlsEvidence.errors.length === 0 &&
    dnsTlsEvidence.evidence?.hostname === productionHostname() &&
    dnsTlsEvidence.evidence?.tls_version === "TLS 1.3" &&
    dnsTlsEvidence.evidence?.auto_renewal === "caddy_acme_letsencrypt" &&
    dnsTlsEvidence.evidence?.hsts_configured === true &&
    dnsTlsEvidence.evidence?.redirect_http_to_https === true;

  const dnsTls = {
    qa_item: "OPS-014",
    evidence_reference: options.dnsTlsEvidenceFile,
    candidate_sha: sha,
    hostname: productionHostname(),
    tls_version: dnsTlsPassed ? "TLS 1.3" : "PENDING_VERIFICATION",
    auto_renewal: dnsTlsPassed ? "caddy_acme_letsencrypt" : "PENDING_VERIFICATION",
    hsts_configured: dnsTlsPassed ? true : false,
    redirect_http_to_https: dnsTlsPassed ? true : false,
    verdict: dnsTlsPassed ? "PASS" : "PENDING",
    evidence_status: dnsTlsPassed ? "VERIFIED" : "PENDING_PRODUCTION_EVIDENCE",
    pending_reasons: dnsTlsPassed ? [] : [...dnsTlsEvidence.errors, "required_provider_observations_not_verified"],
    input_evidence_sha256: dnsTlsEvidence.evidenceSha256,
    verified_evidence_files: dnsTlsEvidence.verifiedFiles,
    generated_at: new Date().toISOString(),
  };
  dnsTls.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(dnsTls, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-dns-tls.json"), JSON.stringify(dnsTls, null, 2));

  // Automated source checks require retained exact-candidate test artifacts.
  // An auditor script does not execute these checks merely by writing a receipt.
  const automatedEvidence = await loadAndValidateEvidence(sha, options.automatedEvidenceFile, {
    allowedEvidenceClasses: ["HOSTED_CI", "LOCAL_EXECUTABLE"],
    requireProductionEnvironment: false,
    requiredFiles: ["test_log"],
  });
  const automated = (section, keys) =>
    automatedEvidence.errors.length === 0 &&
    keys.every((key) => automatedEvidence.evidence?.checks?.[section]?.[key] === "PASS");
  const securityPassed = automated("security", ["dependency_audit", "secret_scan", "security_headers"]);
  const a11yPassed = automated("accessibility", [
    "automated_axe_playwright",
    "reduced_motion_contract",
    "high_contrast_contract",
  ]);
  const privacyPassed = automated("privacy", [
    "policy_source",
    "terms_source",
    "cookies_source",
    "data_retention",
    "data_export",
    "data_deletion",
  ]);
  const templatePassed = automated("email", ["templates"]);
  const automatedProof = {
    ...(automatedEvidence.evidenceSha256 ? { input_evidence_sha256: automatedEvidence.evidenceSha256 } : {}),
    verified_evidence_files: automatedEvidence.verifiedFiles,
  };
  // 2. Security Recertification (Section 21)
  // Independent manual pentest remains waived; automated proof is separately required.
  const security = {
    qa_item: "GATE-F-SECURITY",
    candidate_sha: sha,
    dependency_audit: securityPassed ? "PASS_MODERATE_THRESHOLD" : "PENDING_TEST_EVIDENCE",
    secret_scan: securityPassed ? "PASS_ZERO_LEAKS" : "PENDING_TEST_EVIDENCE",
    security_headers_contract: {
      strict_transport_security: "max-age=31536000; includeSubDomains",
      x_content_type_options: "nosniff",
      referrer_policy: "strict-origin-when-cross-origin",
      frame_ancestors: "none",
    },
    critical_defects: null,
    high_defects: null,
    independent_manual_pentest: "WAIVED_NOT_EXECUTED",
    verdict: securityPassed ? "PASS_AUTOMATED_SCOPE" : "PENDING_TEST_EVIDENCE",
    pending_reasons: securityPassed ? [] : [...automatedEvidence.errors, "exact_sha_security_test_log_required"],
    ...automatedProof,
    generated_at: new Date().toISOString(),
  };
  security.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(security, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-security.json"), JSON.stringify(security, null, 2));

  // 3. SEO Recertification (Section 23)
  // Requires PRODUCTION_LIVE_PROBE or PROVIDER_RECEIPT
  const seoEvidence = await loadAndValidateEvidence(sha, options.seoEvidenceFile, {
    allowedEvidenceClasses: ["PRODUCTION_LIVE_PROBE", "PROVIDER_RECEIPT"],
    requireProductionEnvironment: true,
    requiredFiles: ["provider_capture"],
  });

  const seoPassed =
    seoEvidence.errors.length === 0 &&
    (seoEvidence.evidence?.production_origin === productionOrigin() ||
      seoEvidence.evidence?.hostname === productionHostname()) &&
    seoEvidence.evidence?.robots_txt_status === "PASS" &&
    seoEvidence.evidence?.sitemap_status === "PASS";

  const seo = {
    qa_item: "GATE-F-SEO",
    evidence_reference: options.seoEvidenceFile,
    candidate_sha: sha,
    production_origin: productionOrigin(),
    robots_txt_status: seoPassed ? "PASS" : "PENDING_LIVE_PROBE",
    sitemap_status: seoPassed ? "PASS" : "PENDING_LIVE_PROBE",
    staging_leakage_detected: seoPassed ? false : null,
    verdict: seoPassed ? "PASS" : "PENDING",
    evidence_status: seoPassed ? "VERIFIED" : "PENDING_PRODUCTION_EVIDENCE",
    pending_reasons: seoPassed ? [] : [...seoEvidence.errors, "required_provider_observations_not_verified"],
    input_evidence_sha256: seoEvidence.evidenceSha256,
    verified_evidence_files: seoEvidence.verifiedFiles,
    generated_at: new Date().toISOString(),
  };
  seo.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(seo, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-seo.json"), JSON.stringify(seo, null, 2));

  // 4. Email Recertification (OPS-017, Section 24)
  // Requires PROVIDER_RECEIPT (Resend) or PRODUCTION_LIVE_PROBE
  // Note: Bounce handling is also pending implementation in packages/notifications
  const emailEvidence = await loadAndValidateEvidence(sha, options.emailEvidenceFile, {
    allowedEvidenceClasses: ["PROVIDER_RECEIPT", "PRODUCTION_LIVE_PROBE"],
    requireProductionEnvironment: true,
    requiredFiles: ["provider_capture"],
  });

  const emailPassed =
    emailEvidence.errors.length === 0 &&
    templatePassed &&
    emailEvidence.evidence?.provider === "resend_transactional" &&
    emailEvidence.evidence?.domain === productionHostname() &&
    emailEvidence.evidence?.spf === "PASS" &&
    emailEvidence.evidence?.dkim === "PASS" &&
    emailEvidence.evidence?.dmarc === "PASS" &&
    emailEvidence.evidence?.bounce_handling === "PASS";

  const email = {
    qa_item: "OPS-017",
    evidence_reference: options.emailEvidenceFile,
    candidate_sha: sha,
    provider: "resend_transactional",
    domain: productionHostname(),
    spf: emailPassed ? "PASS" : "PENDING_DNS_RECORD_AUDIT",
    dkim: emailPassed ? "PASS" : "PENDING_DNS_RECORD_AUDIT",
    dmarc: emailPassed ? "PASS" : "PENDING_DNS_RECORD_AUDIT",
    bounce_handling: emailPassed ? "PASS" : "IMPLEMENTED_SOURCE_UNCERTIFIED",
    input_evidence_sha256: emailEvidence.evidenceSha256,
    verified_evidence_files: emailEvidence.verifiedFiles,
    source_implementation: "IMPLEMENTED_SOURCE_UNCERTIFIED",
    template_tests: templatePassed ? "PASS" : "PENDING_TEST_EVIDENCE",
    verdict: emailPassed ? "PASS" : "PENDING",
    evidence_status: emailPassed ? "VERIFIED" : "PENDING_PRODUCTION_EVIDENCE",
    pending_reasons: emailPassed
      ? []
      : [
          ...emailEvidence.errors,
          ...(!templatePassed ? ["exact_sha_email_template_test_log_required"] : []),
          "provider_webhook_and_dns_production_evidence_pending",
        ],
    generated_at: new Date().toISOString(),
  };
  email.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(email, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-email.json"), JSON.stringify(email, null, 2));

  // 5. Accessibility Recertification (Section 22)
  const a11y = {
    qa_item: "GATE-F-A11Y",
    candidate_sha: sha,
    automated_axe_playwright: a11yPassed ? "PASS" : "PENDING_TEST_EVIDENCE",
    reduced_motion_contract: a11yPassed ? "PASS" : "PENDING_TEST_EVIDENCE",
    high_contrast_contract: a11yPassed ? "PASS" : "PENDING_TEST_EVIDENCE",
    human_screen_reader_audit: "WAIVED_NOT_EXECUTED",
    physical_device_matrix_session: "WAIVED_NOT_EXECUTED",
    verdict: a11yPassed ? "PASS_AUTOMATED_SCOPE" : "PENDING_TEST_EVIDENCE",
    pending_reasons: a11yPassed ? [] : [...automatedEvidence.errors, "exact_sha_accessibility_test_log_required"],
    ...automatedProof,
    generated_at: new Date().toISOString(),
  };
  a11y.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(a11y, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-accessibility.json"), JSON.stringify(a11y, null, 2));

  // 6. Legal / Privacy Technical Audit (Section 25, ADR 0005)
  const legal = {
    qa_item: "GATE-F-LEGAL",
    candidate_sha: sha,
    privacy_policy_source_present: privacyPassed ? true : null,
    terms_source_present: privacyPassed ? true : null,
    cookies_source_present: privacyPassed ? true : null,
    data_retention_implemented: privacyPassed ? true : null,
    data_export_implemented: privacyPassed ? true : null,
    data_deletion_implemented: privacyPassed ? true : null,
    formal_authorised_legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE",
    verdict: privacyPassed ? "PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT" : "PENDING_TEST_EVIDENCE",
    pending_reasons: privacyPassed ? [] : [...automatedEvidence.errors, "exact_sha_privacy_test_log_required"],
    ...automatedProof,
    generated_at: new Date().toISOString(),
  };
  legal.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(legal, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-legal-technical.json"), JSON.stringify(legal, null, 2));

  return { dnsTls, security, seo, email, a11y, legal };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  runGateFRecertifications(sha)
    .then((res) => {
      console.log("✓ Gate F recertifications completed: DNS/TLS, Security, SEO, Email, A11y, Legal");
      if (
        res.dnsTls.verdict !== "PASS" ||
        res.seo.verdict !== "PASS" ||
        res.email.verdict !== "PASS" ||
        res.security.verdict !== "PASS_AUTOMATED_SCOPE" ||
        res.a11y.verdict !== "PASS_AUTOMATED_SCOPE" ||
        res.legal.verdict !== "PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT"
      ) {
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
