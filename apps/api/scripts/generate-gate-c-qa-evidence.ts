import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function generateAllQAEvidenceLedgers(): Promise<void> {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const scriptPath = path.join(root, "scripts", "seal-gate-c-certification.mjs");
  execFileSync("node", [scriptPath, `--sha=${sourceSha}`], { cwd: root, stdio: "inherit" });
}

async function main(): Promise<void> {
  await generateAllQAEvidenceLedgers();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
