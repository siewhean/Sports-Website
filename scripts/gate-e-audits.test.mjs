import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGateEEmailAudit } from "./run-gate-e-email-audit.mjs";
import { runGateELegalAudit } from "./run-gate-e-legal-audit.mjs";
import { runGateESecurityAudit } from "./run-gate-e-security-audit.mjs";
import { runGateESeoAudit } from "./run-gate-e-seo-audit.mjs";
import { runGateESloAudit } from "./run-gate-e-slo-audit.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "b".repeat(64);

async function withArtifacts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "matchday-gate-e-audits-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonResponse(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function textResponse(body, headers = {}, status = 200) {
  return new Response(body, { status, headers });
}

test("QA-024 composes exact-SHA Gate D receipts into Gate E SLO evidence", async () => {
  await withArtifacts(async (artifactsDir) => {
    await mkdir(artifactsDir, { recursive: true });
    const base = {
      mode: "staging",
      candidate_sha: SHA,
      deployed_sha: SHA,
      competition_id: "competition-1",
      verdict: "PASS",
      receipt_sha256: HASH,
    };
    await writeFile(path.join(artifactsDir, "qa-010-load-public-summary.json"), JSON.stringify({ ...base, qa_item: "QA-010", peak_summary: { p95Ms: 200, errorRate: 0 } }));
    await writeFile(path.join(artifactsDir, "qa-011-load-scoring-summary.json"), JSON.stringify({ ...base, qa_item: "QA-011", peak_summary: { p95Ms: 400, errorRate: 0 } }));
    await writeFile(path.join(artifactsDir, "qa-011-result-propagation-summary.json"), JSON.stringify({ ...base, qa_item: "QA-011-RP", peak_summary: { p95Ms: 150, errorRate: 0 } }));
    const receipt = await runGateESloAudit(SHA, { artifactsDir });
    assert.equal(receipt.verdict, "PASS");
    assert.equal(receipt.metrics.scoring_peak_2x_p95_ms, 400);
  });
});

test("QA-028 validates deployed metadata, robots and sitemap", async () => {
  await withArtifacts(async (artifactsDir) => {
    const origin = "https://example.test";
    const expectedPaths = ["/", "/competitions", "/pricing", "/privacy", "/terms", "/cookies", "/support", "/notifications"];
    const sitemap = `<?xml version="1.0"?><urlset>${expectedPaths.map((p) => `<url><loc>${origin}${p === "/" ? "" : p}</loc></url>`).join("")}</urlset>`;
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/robots.txt") return textResponse(`User-agent: *\nDisallow: /api/\nDisallow: /organiser/\nDisallow: /score/\nDisallow: /internal/\nSitemap: ${origin}/sitemap.xml\n`);
      if (pathname === "/sitemap.xml") return textResponse(sitemap);
      const html = pathname === "/" ? '<html><head><title>Matchday</title><meta name="description" content="Competitions"><meta property="og:title" content="Matchday"><meta property="og:description" content="Competitions"></head></html>' : "<html></html>";
      return textResponse(html, { "x-matchday-build-id": SHA });
    };
    const receipt = await runGateESeoAudit(SHA, origin, { artifactsDir, fetchImpl });
    assert.equal(receipt.verdict, "PASS");
    assert.equal(receipt.pages.length, expectedPaths.length);
  });
});

test("QA-030 validates SPF, DKIM and DMARC", async () => {
  await withArtifacts(async (artifactsDir) => {
    const resolveTxtImpl = async (name) => {
      if (name === "mail.example.test") return [["v=spf1 include:_spf.example.test -all"]];
      if (name === "_dmarc.mail.example.test") return [["v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test"]];
      if (name === "selector._domainkey.mail.example.test") return [["v=DKIM1; k=rsa; p=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"]];
      throw new Error(`unexpected DNS name ${name}`);
    };
    const receipt = await runGateEEmailAudit(SHA, "mail.example.test", "selector", { artifactsDir, resolveTxtImpl });
    assert.equal(receipt.verdict, "PASS");
    assert.equal(receipt.dmarc.policy, "quarantine");
  });
});

test("automated security audit binds headers and API build metadata to the candidate", async () => {
  await withArtifacts(async (artifactsDir) => {
    const fetchImpl = async (url) => {
      if (new URL(url).pathname === "/api/v1/meta/build") return jsonResponse({ git_sha: SHA, environment: "staging" });
      return textResponse("<html></html>", {
        "x-matchday-build-id": SHA,
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "content-security-policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
      });
    };
    const receipt = await runGateESecurityAudit(SHA, "https://example.test", "https://example.test", { artifactsDir, fetchImpl });
    assert.equal(receipt.verdict, "PASS_AUTOMATED_SCOPE");
    assert.equal(receipt.independent_manual_pentest, "WAIVED_NOT_EXECUTED");
  });
});

test("QA-027 creates a technical policy package while preserving Gate F legal deferment", async () => {
  await withArtifacts(async (artifactsDir) => {
    const receipt = await runGateELegalAudit(SHA, { artifactsDir });
    assert.equal(receipt.formal_authorised_legal_approval, "DEFERRED_TO_GATE_F_BY_ADR_0003");
    const stored = JSON.parse(await readFile(path.join(artifactsDir, "gate-e-legal-package.json"), "utf8"));
    assert.equal(stored.candidate_sha, SHA);
  });
});
