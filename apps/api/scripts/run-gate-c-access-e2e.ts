import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const projects = [
  "gate-c-access-phone-chromium",
  "gate-c-access-phone-webkit",
  "gate-c-access-desktop-chromium",
] as const;

async function run(project: (typeof projects)[number]): Promise<void> {
  const evidenceBase = process.env.GATE_C_ACCESS_EVIDENCE_DIR ?? "artifacts/qa/gate-c-access/editable";
  const child = spawn("pnpm", ["--filter", "@matchday/api", "exec", "tsx", "scripts/run-phase-2-real-e2e.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PHASE2_E2E_PLAYWRIGHT_CONFIG: "playwright.gate-c-access.config.ts",
      PHASE2_E2E_PROJECT: project,
      PHASE2_E2E_SKIP_PHASE2_ORACLE: "1",
      PHASE2_E2E_RETAIN_DIR: path.join(evidenceBase, project),
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error(`${project} exited with code ${String(exitCode)}`);
}

for (const project of projects) await run(project);
process.stdout.write("Gate C access browser matrix passed in three independent infrastructure runs.\n");
