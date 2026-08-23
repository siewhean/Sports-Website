#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shaPattern = /^[a-f0-9]{40}$/u;
const requiredNodeVersion = "v24.18.0";
const requiredPnpmVersion = "10.33.0";

function execute(command, args, cwd, environment = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
}

function assertToolchain() {
  if (process.version !== requiredNodeVersion) {
    throw new Error(`Vercel-equivalent build requires Node ${requiredNodeVersion}, received ${process.version}`);
  }
  const pnpmVersion = execute("pnpm", ["--version"], root).trim();
  if (pnpmVersion !== requiredPnpmVersion) {
    throw new Error(`Vercel-equivalent build requires pnpm ${requiredPnpmVersion}, received ${pnpmVersion}`);
  }
}

function resolveSha(value) {
  const candidate = value ?? execute("git", ["rev-parse", "HEAD"], root).trim();
  if (!shaPattern.test(candidate)) throw new Error("Vercel-equivalent build requires an exact 40-character Git SHA");
  execute("git", ["cat-file", "-e", `${candidate}^{commit}`], root);
  return candidate;
}

async function assertBuildOutput(worktree) {
  try {
    await access(path.join(worktree, "apps", "web", ".next", "BUILD_ID"));
  } catch {
    throw new Error("Vercel-equivalent build did not produce apps/web/.next/BUILD_ID");
  }
}

/** Executes an isolated, frozen install and production web build for one immutable commit. */
export async function verifyVercelEquivalentBuild(options = {}) {
  assertToolchain();
  const sha = resolveSha(options.sha);
  const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-vercel-"));
  let worktreeAdded = false;
  try {
    execute("git", ["worktree", "add", "--detach", directory, sha], root);
    worktreeAdded = true;
    execute("pnpm", ["install", "--frozen-lockfile"], directory);
    execute("git", ["diff", "--exit-code", "--", "pnpm-lock.yaml"], directory);
    const afterInstall = execute("git", ["status", "--porcelain", "--untracked-files=all"], directory).trim();
    if (afterInstall) throw new Error(`Frozen install modified the clean worktree:\n${afterInstall}`);
    execute("pnpm", ["--filter", "@matchday/web", "build"], directory, {
      CI: "1",
      NODE_ENV: "production",
      MATCHDAY_PHASE2_DATA_MODE: "",
    });
    await assertBuildOutput(directory);
    return { sha, status: "PASS", buildOutput: "apps/web/.next/BUILD_ID" };
  } finally {
    if (worktreeAdded) {
      try {
        execute("git", ["worktree", "remove", "--force", directory], root);
      } catch {
        // The following removal still prevents a leaked disposable checkout.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--sha="))
    ?.slice("--sha=".length);
  verifyVercelEquivalentBuild({ sha })
    .then((result) => process.stdout.write(`Vercel-equivalent build passed for ${result.sha}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
