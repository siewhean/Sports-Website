#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

function requireSha(value) {
  if (!value || !SHA_PATTERN.test(value))
    throw new Error(`Gate E security audit requires an exact 40-character SHA; got ${value}`);
  return value.toLowerCase();
}

function requireOrigin(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS origin without credentials, query, or fragment`);
  }
  return parsed.origin;
}

function requireHeader(headers, name, predicate, message) {
  const value = headers.get(name);
  if (!value || !predicate(value))
    throw new Error(`${name} validation failed: ${message}; received ${JSON.stringify(value)}`);
  return value;
}

export async function runGateESecurityAudit(candidateSha, webUrl, apiUrl = webUrl, options = {}) {
  const sha = requireSha(candidateSha);
  const webOrigin = requireOrigin(webUrl, "GATE_E_WEB_URL");
  const apiOrigin = requireOrigin(apiUrl, "GATE_E_API_URL");
  const fetchImpl = options.fetchImpl ?? fetch;
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");

  const web = await fetchImpl(webOrigin, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!web.ok) throw new Error(`Web origin returned HTTP ${web.status}`);
  const buildId = web.headers.get("x-matchday-build-id");
  if (buildId !== sha) throw new Error(`Web build ID mismatch: expected ${sha}, got ${buildId}`);

  const hsts = requireHeader(
    web.headers,
    "strict-transport-security",
    (value) => /max-age=\d+/iu.test(value),
    "must contain max-age",
  );
  const nosniff = requireHeader(
    web.headers,
    "x-content-type-options",
    (value) => value.toLowerCase() === "nosniff",
    "must equal nosniff",
  );
  const referrer = requireHeader(web.headers, "referrer-policy", (value) => value.trim().length > 0, "must be present");
  const csp = requireHeader(
    web.headers,
    "content-security-policy",
    (value) => /(?:^|;)\s*default-src\s+/iu.test(value) && /(?:^|;)\s*object-src\s+'none'/iu.test(value),
    "must define default-src and object-src 'none'",
  );
  if (/unsafe-eval/iu.test(csp)) throw new Error("Content-Security-Policy must not contain unsafe-eval");
  const frameProtected = /(?:^|;)\s*frame-ancestors\s+/iu.test(csp) || Boolean(web.headers.get("x-frame-options"));
  if (!frameProtected) throw new Error("Frame embedding protection is missing");

  const metaResponse = await fetchImpl(`${apiOrigin}/api/v1/meta/build`, { signal: AbortSignal.timeout(20_000) });
  if (!metaResponse.ok) throw new Error(`API build metadata returned HTTP ${metaResponse.status}`);
  const meta = await metaResponse.json();
  if (String(meta.git_sha).toLowerCase() !== sha)
    throw new Error(`API build SHA mismatch: expected ${sha}, got ${meta.git_sha}`);

  const receipt = {
    qa_item: "QA-029-AUTOMATED",
    evidence_class: "gate_e_automated_only",
    candidate_sha: sha,
    web_origin: webOrigin,
    api_origin: apiOrigin,
    headers: {
      strict_transport_security: hsts,
      x_content_type_options: nosniff,
      referrer_policy: referrer,
      content_security_policy_sha256: createHash("sha256").update(csp, "utf8").digest("hex"),
      frame_embedding_protection: "PASS",
      unsafe_eval_absent: true,
    },
    api_build_attestation: { status: "PASS", git_sha: meta.git_sha, environment: meta.environment },
    hosted_ci_requirements: {
      dependency_audit: "REQUIRED_BY_GATE_E_WORKFLOW",
      secrets_scan: "REQUIRED_BY_HOSTED_CI",
      owasp_integration_tests: "REQUIRED_BY_HOSTED_CI",
      token_rate_limit_and_tenant_isolation_tests: "REQUIRED_BY_HOSTED_CI",
    },
    independent_manual_pentest: "WAIVED_NOT_EXECUTED",
    verdict: "PASS_AUTOMATED_SCOPE",
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
  const output = { ...receipt, receipt_sha256: receiptSha256 };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "gate-e-security-automation.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateESecurityAudit(
    process.argv[2] ?? process.env.CANDIDATE_SHA,
    process.argv[3] ?? process.env.GATE_E_WEB_URL,
    process.argv[4] ?? process.env.GATE_E_API_URL ?? process.env.GATE_E_WEB_URL,
  )
    .then(() => console.log("✓ GATE E AUTOMATED SECURITY AUDIT PASS"))
    .catch((error) => {
      console.error(`❌ GATE E AUTOMATED SECURITY AUDIT FAIL: ${error.message}`);
      process.exitCode = 1;
    });
}
