import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gateCC3Projects,
  parseGateCC3Discovery,
  validateGateCC3ProjectReceipt,
  verifyGateCC3ArtifactHashes,
  verifyGateCC3ScenarioArtifacts,
  type GateCC3Project,
} from "./gate-c-c3-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirtyTree = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (dirtyTree) {
  throw new Error(`Refusing Gate C C3 certification on a dirty source tree:\n${dirtyTree}`);
}

function browserVersion(project: GateCC3Project): string {
  const engine = project.endsWith("chromium") ? "chromium" : project.endsWith("webkit") ? "webkit" : "firefox";
  return execFileSync(
    "pnpm",
    [
      "--filter",
      "@matchday/web",
      "exec",
      "node",
      "--input-type=module",
      "-e",
      `import {${engine}} from "@playwright/test";const browser=await ${engine}.launch({headless:true});console.log(browser.version());await browser.close();`,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function discoverTests(): Map<GateCC3Project, number> {
  try {
    const output = execFileSync(
      "pnpm",
      [
        "--filter",
        "@matchday/web",
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.gate-c-c3.config.ts",
        "--list",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseGateCC3Discovery(output);
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    throw new Error(`Gate C C3 Playwright discovery failed.\n${detail}`);
  }
}

const discovery = discoverTests();
const generatedRunId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const profileRoot = path.join(tmpdir(), "matchday-gate-c-c3-profiles", sourceSha, generatedRunId);
const evidenceBase =
  process.env.GATE_C_C3_EVIDENCE_DIR ?? path.join("artifacts", "qa", "gate-c-c3", sourceSha, "runs", generatedRunId);
const evidenceDirectory = path.resolve(root, evidenceBase);
const allowedRoot = path.join(root, "artifacts", "qa", "gate-c-c3", sourceSha);

if (
  !evidenceDirectory.startsWith(`${allowedRoot}${path.sep}`) ||
  evidenceDirectory.split(path.sep).includes("editable")
) {
  throw new Error("Gate C C3 evidence must use a unique directory beneath its exact-SHA root");
}
await mkdir(allowedRoot, { recursive: true });
if ((await realpath(allowedRoot)) !== allowedRoot) {
  throw new Error("Gate C C3 evidence source directory must not traverse symlinks");
}
await mkdir(path.dirname(evidenceDirectory), { recursive: true });
await mkdir(evidenceDirectory);
if (!(await realpath(evidenceDirectory)).startsWith(`${allowedRoot}${path.sep}`)) {
  throw new Error("Gate C C3 evidence directory escaped its exact-SHA retention root");
}

async function runProject(project: GateCC3Project) {
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const profileDirectory = path.join(profileRoot, project);
  const child = spawn("pnpm", ["--filter", "@matchday/api", "exec", "tsx", "scripts/run-phase-2-real-e2e.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PHASE2_E2E_PLAYWRIGHT_CONFIG: "playwright.gate-c-c3.config.ts",
      PHASE2_E2E_PROJECT: project,
      PHASE2_E2E_EVIDENCE_SCOPE: "gate-c-c3",
      PHASE2_E2E_RETAIN_DIR: path.join(evidenceDirectory, project),
      PHASE2_E2E_PERSISTENT_PROFILE: profileDirectory,
      GATE_C_C3_BROWSER_VERSION: browserVersion(project),
    },
    stdio: "inherit",
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (exitCode !== 0) throw new Error(`${project} exited with code ${String(exitCode)}`);
    const receiptPath = path.join(evidenceDirectory, project, "project-evidence.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    const expectedPassCount = discovery.get(project);
    if (!expectedPassCount) throw new Error(`${project} has no discovered test count`);
    const validated = validateGateCC3ProjectReceipt(receipt, sourceSha, project, expectedPassCount);
    await verifyGateCC3ArtifactHashes(path.join(evidenceDirectory, project), validated.artifact_hashes);
    await verifyGateCC3ScenarioArtifacts(path.join(evidenceDirectory, project), validated);
    return {
      project_name: project,
      pass_count: expectedPassCount,
      started_at: startedAt.toISOString(),
      duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000,
      evidence_path: `${project}/project-evidence.json`,
    };
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

const startedAt = new Date();
const started = process.hrtime.bigint();
const projects = [];
for (const project of gateCC3Projects) projects.push(await runProject(project));
await writeFile(
  path.join(evidenceDirectory, "run-evidence.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      artifact_kind: "gate-c-c3-run-evidence",
      source_sha: sourceSha,
      run_id: path.basename(evidenceDirectory),
      started_at: startedAt.toISOString(),
      duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000,
      pass_count: projects.reduce((sum, project) => sum + project.pass_count, 0),
      failed_count: 0,
      skipped_count: 0,
      projects,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
process.stdout.write("Gate C C3 browser matrix passed in five isolated persistent profiles.\n");
