import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gateCC2Projects,
  parseGateCC2Discovery,
  validateGateCC2ScreenshotPaths,
  validateGateCC2SemanticReceipt,
  type GateCC2Project,
} from "./gate-c-c2-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

execFileSync("pnpm", ["--filter", "@matchday/domain", "build"], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});

function discoverTests(): Map<GateCC2Project, number> {
  let output: string;
  try {
    output = execFileSync(
      "pnpm",
      [
        "--filter",
        "@matchday/web",
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.gate-c-c2.config.ts",
        "--list",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    throw new Error(
      `Gate C C2 real browser test discovery failed. Implement apps/web/tests/gate-c-c2-real.spec.ts before evidence execution.\n${detail}`,
    );
  }
  return parseGateCC2Discovery(output);
}

const discoveredCounts = discoverTests();
const generatedRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
const evidenceBase =
  process.env.GATE_C_C2_EVIDENCE_DIR ?? path.join("artifacts", "qa", "gate-c-c2", sourceSha, "runs", generatedRunId);
const evidenceDirectory = path.resolve(root, evidenceBase);
const allowedRoot = path.join(root, "artifacts", "qa", "gate-c-c2", sourceSha);
if (
  !evidenceDirectory.startsWith(`${allowedRoot}${path.sep}`) ||
  evidenceDirectory.split(path.sep).includes("editable")
) {
  throw new Error("Gate C C2 evidence must use a unique directory beneath its exact-SHA root");
}
await mkdir(allowedRoot, { recursive: true });
if ((await realpath(allowedRoot)) !== allowedRoot) {
  throw new Error("Gate C C2 evidence source directory must not traverse symlinks");
}
await mkdir(path.dirname(evidenceDirectory), { recursive: true });
await mkdir(evidenceDirectory);
if (!(await realpath(evidenceDirectory)).startsWith(`${allowedRoot}${path.sep}`)) {
  throw new Error("Gate C C2 evidence directory escaped its exact-SHA retention root");
}

async function run(project: GateCC2Project) {
  const startedAt = new Date();
  const startedAtNanoseconds = process.hrtime.bigint();
  const child = spawn("pnpm", ["--filter", "@matchday/api", "exec", "tsx", "scripts/run-phase-2-real-e2e.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PHASE2_E2E_PLAYWRIGHT_CONFIG: "playwright.gate-c-c2.config.ts",
      PHASE2_E2E_PROJECT: project,
      PHASE2_E2E_EVIDENCE_SCOPE: "gate-c-c2",
      PHASE2_E2E_RETAIN_DIR: path.join(evidenceDirectory, project),
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error(`${project} exited with code ${String(exitCode)}`);
  const evidence = JSON.parse(
    await readFile(path.join(evidenceDirectory, project, "project-evidence.json"), "utf8"),
  ) as {
    artifact_kind?: string;
    source_sha?: string;
    project_name?: string;
    pass_count?: number;
    postgresql?: { identifier_sha256?: string };
    redis?: {
      logical_database?: number;
      namespace_sha256?: string;
      initial_owned_key_count?: number;
      final_owned_key_count?: number;
      unrelated_guard_preserved?: boolean;
    };
    screenshot_paths?: string[];
    result_paths?: string[];
    semantic_oracle?: unknown;
  };
  const expectedPassCount = discoveredCounts.get(project);
  if (
    evidence.artifact_kind !== "gate-c-c2-project-evidence" ||
    evidence.source_sha !== sourceSha ||
    evidence.project_name !== project ||
    evidence.pass_count !== expectedPassCount ||
    !/^[a-f0-9]{64}$/u.test(evidence.postgresql?.identifier_sha256 ?? "") ||
    typeof evidence.redis?.logical_database !== "number" ||
    !Number.isSafeInteger(evidence.redis.logical_database) ||
    !/^[a-f0-9]{64}$/u.test(evidence.redis?.namespace_sha256 ?? "") ||
    evidence.redis?.initial_owned_key_count !== 0 ||
    evidence.redis?.final_owned_key_count !== 0 ||
    evidence.redis?.unrelated_guard_preserved !== true ||
    !validateGateCC2SemanticReceipt(evidence.semantic_oracle, project) ||
    !validateGateCC2ScreenshotPaths(evidence.screenshot_paths) ||
    !evidence.result_paths?.length
  ) {
    throw new Error(`${project} emitted invalid Gate C C2 evidence`);
  }
  return {
    project_name: project,
    pass_count: expectedPassCount!,
    started_at: startedAt.toISOString(),
    duration_ms: Number(process.hrtime.bigint() - startedAtNanoseconds) / 1_000_000,
    evidence_path: `${project}/project-evidence.json`,
  };
}

const runStartedAt = new Date();
const runStartedAtNanoseconds = process.hrtime.bigint();
const projectResults = [];
for (const project of gateCC2Projects) projectResults.push(await run(project));
await writeFile(
  path.join(evidenceDirectory, "run-evidence.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      artifact_kind: "gate-c-c2-run-evidence",
      source_sha: sourceSha,
      run_id: path.basename(evidenceDirectory),
      started_at: runStartedAt.toISOString(),
      duration_ms: Number(process.hrtime.bigint() - runStartedAtNanoseconds) / 1_000_000,
      pass_count: projectResults.reduce((total, project) => total + project.pass_count, 0),
      projects: projectResults,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
process.stdout.write("Gate C C2 browser matrix passed in three isolated project runs.\n");
