import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATE_C_C5_STAGING_FAULTS,
  GATE_C_C5_STAGING_PHASES,
  expandGateCC5FaultCommandEnvironment,
  parseGateCC5FaultCommandManifest,
} from "./run-gate-c-c5-from-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function packageScripts() {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts;
}

function validFaultManifest() {
  return Object.fromEntries(
    GATE_C_C5_STAGING_FAULTS.map((fault) => [
      fault,
      Object.fromEntries(
        GATE_C_C5_STAGING_PHASES.map((phase) => [phase, `/opt/matchday-gate-c/fault ${fault} ${phase.toLowerCase()}`]),
      ),
    ]),
  );
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

test("Gate D staging runners execute from the API workspace that owns their dependencies", async () => {
  const scripts = await packageScripts();
  for (const script of [
    "seed:staging:pilot",
    "test:load:public",
    "test:load:scoring",
    "test:load:component",
    "test:load:socket-component",
    "test:load:staging",
  ]) {
    assert.match(
      scripts[script],
      /pnpm --filter @matchday\/api exec tsx scripts\//u,
      `${script} must use API workspace`,
    );
    assert.doesNotMatch(scripts[script], /\.\.\/\.\.\/scripts\//u, `${script} must not execute root-owned TypeScript`);
  }
});

test("release readiness runs Gate D source tests and the real browser journey without requiring external receipts", async () => {
  const source = await readFile(path.join(root, "scripts/release-suite-guard.mjs"), "utf8");
  assert.match(source, /pnpm test:check:source/u);
  assert.match(source, /pnpm test:evidence:gate-d/u);
  assert.match(source, /pnpm test:e2e:phase7:real/u);
  assert.doesNotMatch(source, /pnpm evidence:gate-d:verify/u);
});

test("QA-011 propagation reuses already-started benchmark matches", async () => {
  const source = await readFile(path.join(root, "apps/api/scripts/run-load-scoring.ts"), "utf8");
  const start = source.indexOf("async function prepareResultPropagationMatch");
  const end = source.indexOf("\nfunction validWriterHeartbeat", start);
  assert.ok(start >= 0 && end > start, "QA-011 propagation preparation function must remain inspectable");
  const preparation = source.slice(start, end);
  assert.doesNotMatch(preparation, /type:\s*"match_started"/u);
  assert.match(preparation, /session\.sequence\s*<\s*1/u);
  assert.match(preparation, /type:\s*"point"/u);
  assert.match(preparation, /type:\s*"set_completion"/u);
});

test("C5 staging fault manifest expands to exactly 72 safe command variables", () => {
  const parsed = parseGateCC5FaultCommandManifest(JSON.stringify(validFaultManifest()));
  const expanded = expandGateCC5FaultCommandEnvironment(parsed);
  assert.equal(Object.keys(expanded).length, 72);
  assert.equal(
    expanded.GATE_C_C5_POSTGRES_INTERRUPTION_PRECONDITION_COMMAND,
    "/opt/matchday-gate-c/fault postgres_interruption precondition",
  );
});

test("C5 staging fault manifest rejects missing, extra, relative, and shell commands", () => {
  const missing = validFaultManifest();
  delete missing.postgres_interruption.CLEANUP;
  assert.throws(() => parseGateCC5FaultCommandManifest(JSON.stringify(missing)), /exactly/u);

  const extra = validFaultManifest();
  extra.postgres_interruption.EXTRA = "/opt/matchday-gate-c/fault postgres_interruption extra";
  assert.throws(() => parseGateCC5FaultCommandManifest(JSON.stringify(extra)), /exactly/u);

  const relative = validFaultManifest();
  relative.redis_interruption.INJECT = "gate-c-fault redis_interruption inject";
  assert.throws(() => parseGateCC5FaultCommandManifest(JSON.stringify(relative)), /absolute operator executable/u);

  const unsafe = validFaultManifest();
  unsafe.worker_interruption.RECOVER = "/opt/matchday-gate-c/fault worker_interruption recover;echo nope";
  assert.throws(() => parseGateCC5FaultCommandManifest(JSON.stringify(unsafe)), /missing or unsafe/u);
});
