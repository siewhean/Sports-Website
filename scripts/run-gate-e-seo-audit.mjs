#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const PUBLIC_PATHS = ["/", "/competitions", "/pricing", "/privacy", "/terms", "/cookies", "/support", "/notifications"];

function requireSha(value) {
  if (!value || !SHA_PATTERN.test(value))
    throw new Error(`Gate E SEO audit requires an exact 40-character SHA; got ${value}`);
  return value.toLowerCase();
}

function requireOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Gate E SEO audit target must be an HTTPS origin without credentials, query, or fragment");
  }
  return parsed.origin;
}

function requireMatch(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`SEO audit failed: ${label}`);
}

export async function runGateESeoAudit(candidateSha, targetUrl, options = {}) {
  const sha = requireSha(candidateSha);
  const origin = requireOrigin(targetUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const pageResults = [];

  for (const publicPath of PUBLIC_PATHS) {
    const response = await fetchImpl(`${origin}${publicPath}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${publicPath} returned HTTP ${response.status}`);
    const buildId = response.headers.get("x-matchday-build-id");
    if (buildId !== sha) throw new Error(`${publicPath} build ID mismatch: expected ${sha}, got ${buildId}`);
    const html = await response.text();
    if (publicPath === "/") {
      requireMatch(html, /<title[^>]*>[^<]+<\/title>/iu, "home page must contain a non-empty title");
      requireMatch(
        html,
        /<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/iu,
        "home page must contain a meta description",
      );
      requireMatch(
        html,
        /<meta[^>]+property=["']og:title["'][^>]+content=["'][^"']+["']/iu,
        "home page must contain OpenGraph title metadata",
      );
      requireMatch(
        html,
        /<meta[^>]+property=["']og:description["'][^>]+content=["'][^"']+["']/iu,
        "home page must contain OpenGraph description metadata",
      );
    }
    pageResults.push({ path: publicPath, status: response.status, build_id: buildId });
  }

  const robotsResponse = await fetchImpl(`${origin}/robots.txt`, { signal: AbortSignal.timeout(20_000) });
  if (!robotsResponse.ok) throw new Error(`robots.txt returned HTTP ${robotsResponse.status}`);
  const robots = await robotsResponse.text();
  for (const blocked of ["/api/", "/organiser/", "/score/", "/internal/"]) {
    if (!robots.includes(`Disallow: ${blocked}`)) throw new Error(`robots.txt must disallow ${blocked}`);
  }
  if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`))
    throw new Error("robots.txt does not advertise the canonical sitemap");

  const sitemapResponse = await fetchImpl(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(20_000) });
  if (!sitemapResponse.ok) throw new Error(`sitemap.xml returned HTTP ${sitemapResponse.status}`);
  const sitemap = await sitemapResponse.text();
  for (const publicPath of PUBLIC_PATHS) {
    const absolute = `${origin}${publicPath === "/" ? "" : publicPath}`;
    if (!sitemap.includes(`<loc>${absolute}</loc>`)) throw new Error(`sitemap.xml is missing ${absolute}`);
  }

  const receipt = {
    qa_item: "QA-028",
    evidence_class: "gate_e_automated_only",
    candidate_sha: sha,
    target_url: origin,
    pages: pageResults,
    robots: { status: robotsResponse.status, sitemap: `${origin}/sitemap.xml` },
    sitemap: { status: sitemapResponse.status, expected_url_count: PUBLIC_PATHS.length },
    verdict: "PASS",
    generated_at: new Date().toISOString(),
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
  const output = { ...receipt, receipt_sha256: receiptSha256 };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-e-seo-audit.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGateESeoAudit(process.argv[2] ?? process.env.CANDIDATE_SHA, process.argv[3] ?? process.env.GATE_E_WEB_URL)
    .then((receipt) => {
      console.log("✓ QA-028 GATE E SEO AUDIT PASS");
      console.log(`  Target: ${receipt.target_url}`);
    })
    .catch((error) => {
      console.error(`❌ QA-028 GATE E SEO AUDIT FAIL: ${error.message}`);
      process.exitCode = 1;
    });
}
