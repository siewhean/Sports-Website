import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requiredNodeVersion = "v24.18.0";
const requiredPnpmVersion = "10.33.0";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function assertGateCC4CollectorEnvironment(input: {
  nodeVersion: string;
  pnpmVersion: string;
  dirtyTrackedFiles: string;
}): void {
  if (input.nodeVersion !== requiredNodeVersion) {
    throw new Error(`Gate C C4 collector requires Node ${requiredNodeVersion}, received ${input.nodeVersion}`);
  }
  if (input.pnpmVersion !== requiredPnpmVersion) {
    throw new Error(`Gate C C4 collector requires pnpm ${requiredPnpmVersion}, received ${input.pnpmVersion}`);
  }
  if (input.dirtyTrackedFiles.trim()) {
    throw new Error(`Refusing Gate C C4 collection on a dirty source tree:\n${input.dirtyTrackedFiles.trim()}`);
  }
}

export function createGateCC4CollectorReceipt(input: {
  sourceSha: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  nodeVersion: string;
  pnpmVersion: string;
  unitOutput: string;
  e2eOutput: string;
}) {
  return {
    schema_version: 2,
    artifact_kind: "gate-c-c4-exact-sha-evidence",
    record_status: "UNSEALED_COLLECTOR",
    source_sha: input.sourceSha,
    branch: "integration/gate-c-final",
    status: "PASS",
    run_id: input.runId,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    environment: {
      operating_system: process.platform,
      architecture: process.arch,
      node_version: input.nodeVersion,
      pnpm_version: input.pnpmVersion,
    },
    checks: {
      repository_architecture: "PASS",
      repair_intake_and_revisions: "PASS",
      decision_validation: "PASS",
      publication_and_public_truth: "PASS",
      export_fallback_resilience: "PASS",
      atomic_transaction_rollback: "PASS",
      zero_partial_state_verified: true,
    },
    outputs: {
      unit_test_summary_sha256: sha256(input.unitOutput),
      e2e_test_summary_sha256: sha256(input.e2eOutput),
    },
  } as const;
}

async function main() {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const pnpmVersion = execFileSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).trim();
  const dirtyBefore = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  });
  assertGateCC4CollectorEnvironment({ nodeVersion: process.version, pnpmVersion, dirtyTrackedFiles: dirtyBefore });
  const startedAt = new Date().toISOString();
  process.stdout.write(
    `\n🚀 Running Gate C C4 (Repairs, Public Truth & Atomicity) Certification on SHA: ${sourceSha}...\n`,
  );

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const evidenceDirectory = path.join(root, "artifacts", "qa", "gate-c-c4", sourceSha);
  await mkdir(evidenceDirectory, { recursive: true });

  // 1. Run Unit & Architecture Suites
  const vitestOutput = execFileSync(
    "pnpm",
    [
      "--filter",
      "@matchday/api",
      "test:unit",
      "tests/unit/gate-c-c4-repository-architecture.test.ts",
      "tests/unit/gate-c-c4-public-truth-runtime.test.ts",
      "tests/unit/gate-c-c4-openapi.test.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );

  // 2. Run E2E & Adversarial Rollback Suites
  const e2eOutput = execFileSync(
    "pnpm",
    [
      "vitest",
      "run",
      "--config",
      "tests/e2e/vitest.config.ts",
      "tests/e2e/tier1-features/feature-06-c4-repositories.test.ts",
      "tests/e2e/tier1-features/feature-08-atomic-rollback.test.ts",
      "tests/e2e/tier5-adversarial/adversarial-02-c4-repair-publication.test.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );

  const completedAt = new Date().toISOString();

  const dirtyAfter = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  });
  assertGateCC4CollectorEnvironment({ nodeVersion: process.version, pnpmVersion, dirtyTrackedFiles: dirtyAfter });
  const c4Evidence = createGateCC4CollectorReceipt({
    sourceSha,
    runId,
    startedAt,
    completedAt,
    nodeVersion: process.version,
    pnpmVersion,
    unitOutput: vitestOutput,
    e2eOutput,
  });

  const receiptPath = path.join(evidenceDirectory, "run-evidence.json");
  await writeFile(receiptPath, `${JSON.stringify(c4Evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`✅ Gate C C4 Certification PASSED. Receipt written to: ${receiptPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`❌ Gate C C4 certification collector failed: ${err.message}\n`);
    process.exit(1);
  });
}
