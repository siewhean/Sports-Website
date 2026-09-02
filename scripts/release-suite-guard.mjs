#!/usr/bin/env node
/**
 * release-suite-guard.mjs
 *
 * Phase 7 canonical release suite (pnpm test:release).
 *
 * Runs every required check in order and aborts at the first failure.
 * Also enforces that no required test suite silently reports zero executed tests.
 *
 * This script is the single source of truth for what "release-ready" means.
 * Every Phase 7 Gate D / Gate E evidence set must show this script exiting 0
 * on an exact frozen candidate SHA.
 *
 * Suites are grouped into three phases that mirror CI:
 *   Phase A — static analysis (no infrastructure)
 *   Phase B — integration + migration (requires postgres + redis + mailpit)
 *   Phase C — browser E2E + Gate D real E2E + a11y + visual (requires full stack)
 *
 * Exit codes:
 *   0   all required suites passed with verified test counts
 *   1   a suite failed, was unreachable, or reported zero executed tests
 *   2   configuration error (unknown RELEASE_PHASE)
 */

import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VALID_PHASES = new Set(["ALL", "A", "B", "C"]);

export function parseNonzeroTestCount(output) {
  if (!output || typeof output !== "string") return 0;

  // Vitest: "Tests  251 passed (251)" or "✓  (25 tests)"
  const vitestMatch = output.match(/Tests\s+(\d+)\s+passed/i) || output.match(/(\d+)\s+passed\s+\(\d+\)/i);
  if (vitestMatch && vitestMatch[1]) {
    return parseInt(vitestMatch[1], 10);
  }

  // Node.js --test: "ℹ pass 19" or "✔ ... (19)"
  const nodeTestMatch = output.match(/ℹ\s+pass\s+(\d+)/i) || output.match(/✔[^\n]+\((\d+)\s+tests?\)/i);
  if (nodeTestMatch && nodeTestMatch[1]) {
    return parseInt(nodeTestMatch[1], 10);
  }

  // Playwright: "12 passed (1.2s)"
  const playwrightMatch = output.match(/(\d+)\s+passed\b/i);
  if (playwrightMatch && playwrightMatch[1]) {
    return parseInt(playwrightMatch[1], 10);
  }

  // Fixture / OpenAPI / Load benchmark validation custom scripts
  if (
    output.includes("Validated") ||
    output.includes("current and valid JSON") ||
    output.includes("no leaks found") ||
    output.includes("benchmark PASS") ||
    output.includes("benchmark complete") ||
    output.includes("qualification: PASS")
  ) {
    return 1;
  }

  return 0;
}

/** Run a shell command, streaming output, verifying non-zero exit and test counts. */
export function runCommand(label, cmd, options = {}) {
  const { isInfra = false, expectTests = false } = options;

  console.log(`\n${"─".repeat(72)}`);
  console.log(`[release-suite] ${label}`);
  console.log(`  > ${cmd}`);
  if (isInfra) {
    console.log(`  [env] RUN_INFRA_TESTS=1`);
  }
  console.log(`${"─".repeat(72)}\n`);

  const env = {
    ...process.env,
    ...(isInfra ? { RUN_INFRA_TESTS: "1" } : {}),
  };

  const result = spawnSync(cmd, {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
    env,
    encoding: "utf8",
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status !== 0) {
    console.error(`\n[release-suite] ❌ ${label} failed with exit code ${result.status}`);
    const error = new Error(`Command failed with exit code ${result.status}: ${cmd}`);
    error.status = result.status;
    throw error;
  }

  if (expectTests) {
    const combinedOutput = stdout + "\n" + stderr;
    const testCount = parseNonzeroTestCount(combinedOutput);
    if (testCount <= 0) {
      console.error(`\n[release-suite] ❌ ${label} reported 0 executed tests (silent skip detected).`);
      const error = new Error(`Zero executed tests detected for: ${cmd}`);
      error.status = 1;
      throw error;
    }
    console.log(`[release-suite] ✓ Non-zero test assertion passed (${testCount} test(s) executed)`);
  }
}

// ---------------------------------------------------------------------------
// Execution Guard CLI
// ---------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PHASE = process.env.RELEASE_PHASE ?? "ALL";
  if (!VALID_PHASES.has(PHASE)) {
    console.error(`[release-suite] Unknown RELEASE_PHASE="${PHASE}". Use A, B, C, or ALL.`);
    process.exit(2);
  }

  try {
    // Phase A — static analysis (no infrastructure)
    if (PHASE === "ALL" || PHASE === "A") {
      runCommand("1  Secret scan", "pnpm secrets:scan");
      runCommand("2  Dependency audit", "pnpm dependencies:audit");
      runCommand("3  Format check", "pnpm format:check");
      runCommand("4  Lint", "pnpm lint");
      runCommand("5  Type-check", "pnpm typecheck");
      runCommand("6  Unit tests (all packages)", "pnpm test:unit", { expectTests: true });
      runCommand("7  Gate C evidence seals", "pnpm test:seal:gate-c && pnpm test:evidence:gate-c", {
        expectTests: true,
      });
      runCommand(
        "8  Fixture validation",
        "pnpm validate:fixtures && pnpm validate:phase2 && pnpm validate:phase3 && pnpm validate:phase4",
      );
      runCommand("9  OpenAPI contract", "pnpm openapi:check");
      runCommand("10  Vercel deployment verification", "pnpm test:vercel:verify", { expectTests: true });
      runCommand("11  Gate D source contract", "pnpm test:check:source", { expectTests: true });
      runCommand("12  Gate D receipt validator", "pnpm test:evidence:gate-d", { expectTests: true });
    }

    // Phase B — integration + migration (requires postgres + redis + mailpit)
    if (PHASE === "ALL" || PHASE === "B") {
      runCommand("13  Build (all packages)", "pnpm build");
      runCommand("14  Migration check", "pnpm db:migrate:check");
      runCommand("15  Backup restoration verification", "pnpm backup:verify", { isInfra: true });
      runCommand("16  Integration tests", "pnpm test:integration", { isInfra: true, expectTests: true });
    }

    // Phase C — browser E2E + a11y + visual (requires full stack)
    if (PHASE === "ALL" || PHASE === "C") {
      runCommand("17  Browser E2E", "pnpm test:e2e", { isInfra: true, expectTests: true });
      runCommand("18  Gate D real browser qualification", "pnpm test:e2e:phase7:real", {
        isInfra: true,
        expectTests: true,
      });
      runCommand("19  Accessibility (Playwright a11y)", "pnpm test:a11y", { isInfra: true, expectTests: true });
      runCommand("20  Visual regression", "pnpm test:visual", { isInfra: true, expectTests: true });
    }

    console.log("\n" + "═".repeat(72));
    console.log(`[release-suite] ✓ All required suites passed (phase=${PHASE})`);
    console.log("═".repeat(72) + "\n");
  } catch (error) {
    process.exit(error.status || 1);
  }
}
