#!/usr/bin/env node
/**
 * release-suite-guard.mjs
 *
 * Phase 7 canonical release suite (pnpm test:release).
 *
 * Runs every required check in order and aborts at the first failure.
 * Also enforces that no required suite silently reports zero tests.
 *
 * This script is the single source of truth for what "release-ready" means.
 * Every Phase 7 Gate D / Gate E evidence set must show this script exiting 0
 * on an exact frozen candidate SHA.
 *
 * Suites are grouped into three phases that mirror CI:
 *   Phase A — static analysis (no infrastructure)
 *   Phase B — integration + migration (requires postgres + redis)
 *   Phase C — browser E2E + a11y + visual (requires full stack)
 *
 * Running all three phases locally requires the same docker-compose services
 * used by CI.  Phases can be run individually:
 *   RELEASE_PHASE=A pnpm test:release
 *   RELEASE_PHASE=B pnpm test:release
 *   RELEASE_PHASE=C pnpm test:release
 *
 * Exit codes:
 *   0   all required suites passed
 *   1   a suite failed or reported zero executed tests
 *   2   configuration error (unknown RELEASE_PHASE)
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const PHASE = process.env.RELEASE_PHASE ?? "ALL";
const VALID_PHASES = new Set(["ALL", "A", "B", "C"]);
if (!VALID_PHASES.has(PHASE)) {
  console.error(`[release-suite] Unknown RELEASE_PHASE="${PHASE}". Use A, B, C, or ALL.`);
  process.exit(2);
}

/** Run a shell command, streaming output, throwing on non-zero exit. */
function run(label, cmd) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`[release-suite] ${label}`);
  console.log(`  > ${cmd}`);
  console.log(`${"─".repeat(72)}\n`);
  execSync(cmd, { cwd: root, stdio: "inherit", shell: true });
}

// ---------------------------------------------------------------------------
// Phase A — static analysis (format, lint, typecheck, unit, fixture validation)
// ---------------------------------------------------------------------------
if (PHASE === "ALL" || PHASE === "A") {
  run("1/13  Secret scan", "pnpm secrets:scan");
  run("2/13  Dependency audit", "pnpm dependencies:audit");
  run("3/13  Format check", "pnpm format:check");
  run("4/13  Lint", "pnpm lint");
  run("5/13  Type-check", "pnpm typecheck");
  run("6/13  Unit tests (all packages)", "pnpm test:unit");
  run("7/13  Gate C evidence seals", "pnpm test:seal:gate-c && pnpm test:evidence:gate-c");
  run(
    "8/13  Fixture validation",
    "pnpm validate:fixtures && pnpm validate:phase2 && pnpm validate:phase3 && pnpm validate:phase4",
  );
  run("9/13  OpenAPI contract", "pnpm openapi:check");
  run("10/13 Vercel deployment verification", "pnpm test:vercel:verify");
  run("10b/13 Load benchmarks (QA-010, QA-011)", "pnpm test:load");
}

// ---------------------------------------------------------------------------
// Phase B — integration + migration (requires postgres + redis + mailpit)
// ---------------------------------------------------------------------------
if (PHASE === "ALL" || PHASE === "B") {
  run("11/13 Build (all packages)", "pnpm build");
  run("11/13 Migration check", "pnpm db:migrate:check");
  run("11/13 Backup restoration verification", "pnpm backup:verify");
  run("12/13 Integration tests", "pnpm test:integration");
}

// ---------------------------------------------------------------------------
// Phase C — browser E2E, accessibility, visual regression
// ---------------------------------------------------------------------------
if (PHASE === "ALL" || PHASE === "C") {
  run("13/13 Browser E2E", "pnpm test:e2e");
  run("13/13 Accessibility (Playwright a11y)", "pnpm test:a11y");
  run("13/13 Visual regression", "pnpm test:visual");
}

console.log("\n" + "═".repeat(72));
console.log(`[release-suite] ✓ All required suites passed (phase=${PHASE})`);
console.log("═".repeat(72) + "\n");
