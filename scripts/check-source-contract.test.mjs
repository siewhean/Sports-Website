import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function packageScripts() {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts;
}

test("source verification is executable before final certification evidence exists", async () => {
  const scripts = await packageScripts();
  const source = scripts["check:source"];
  assert.equal(typeof source, "string");
  assert.match(source, /\bpnpm ci:assert-clean-outputs\b/u);
  assert.match(source, /\bpnpm test:vercel:build\b/u);
  assert.equal(scripts["test:vercel:build"], "node scripts/verify-vercel-equivalent-build.mjs");
  assert.equal(scripts["evidence:gate-c-c4:run"], "pnpm --filter @matchday/api exec tsx scripts/run-gate-c-c4-e2e.ts");
  assert.doesNotMatch(source, /\bevidence:gate-c:verify\b/u);
  assert.doesNotMatch(source, /\bevidence:gate-c:seal\b/u);
  for (const nonSourceGate of [
    "pnpm backup:verify",
    "pnpm test:integration",
    "pnpm test:e2e",
    "pnpm test:a11y",
    "pnpm test:visual",
    "pnpm deploy:manifest",
    "pnpm asset-delivery:verify:origin",
  ]) {
    assert.equal(source.includes(nonSourceGate), false, `${nonSourceGate} must not be a source-only gate`);
  }
});

test("final verification requires source verification followed by exact-SHA evidence", async () => {
  const scripts = await packageScripts();
  assert.equal(scripts.check, "pnpm check:source && pnpm evidence:gate-c:verify");
});
