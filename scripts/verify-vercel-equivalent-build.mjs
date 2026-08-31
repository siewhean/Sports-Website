#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shaPattern = /^[a-f0-9]{40}$/u;
const requiredNodeVersion = "v24.18.0";
const requiredPnpmVersion = "10.33.0";
const gateCBranch = "integration/gate-c-final";
const expectedInstallCommand = "cd ../.. && pnpm install --frozen-lockfile";
const expectedBuildCommand = "cd ../.. && pnpm turbo run build --filter=@matchday/web... --force";
const expectedIgnoreCommand = "sh scripts/vercel-ignore-build.sh";

function execute(command, args, cwd, environment = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
}

function executeShell(command, cwd, environment = {}) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${String(result.status)}): ${command}\n${result.stderr || result.stdout || "no output"}`,
    );
  }
  return result.stdout;
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

async function readAndValidateVercelConfig(worktree, sha) {
  const webRoot = path.join(worktree, "apps", "web");
  const configPath = path.join(webRoot, "vercel.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Vercel-equivalent build requires valid apps/web/vercel.json: ${String(error)}`);
  }
  if (
    config?.installCommand !== expectedInstallCommand ||
    config?.buildCommand !== expectedBuildCommand ||
    config?.ignoreCommand !== expectedIgnoreCommand
  ) {
    throw new Error("apps/web/vercel.json no longer matches the Gate C deployment contract");
  }
  const ignoreResult = spawnSync("/bin/sh", ["-c", config.ignoreCommand], {
    cwd: webRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VERCEL_GIT_COMMIT_REF: gateCBranch,
      VERCEL_GIT_PREVIOUS_SHA: sha,
    },
  });
  if (ignoreResult.error) throw ignoreResult.error;
  if (ignoreResult.status !== 1) {
    throw new Error(
      `Gate C Vercel ignoreCommand must exit 1 (build) for ${gateCBranch}; received ${String(ignoreResult.status)}`,
    );
  }
  return { config, webRoot };
}

/** Executes the exact repo-declared Vercel install/build commands in an isolated worktree. */
export async function verifyVercelEquivalentBuild(options = {}) {
  assertToolchain();
  const sha = resolveSha(options.sha);
  const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-vercel-"));
  let worktreeAdded = false;
  try {
    execute("git", ["worktree", "add", "--detach", directory, sha], root);
    worktreeAdded = true;
    const { config, webRoot } = await readAndValidateVercelConfig(directory, sha);
    executeShell(config.installCommand, webRoot, {
      CI: "1",
      VERCEL_GIT_COMMIT_REF: gateCBranch,
      VERCEL_GIT_PREVIOUS_SHA: sha,
    });
    execute("git", ["diff", "--exit-code", "--", "pnpm-lock.yaml"], directory);
    const afterInstall = execute("git", ["status", "--porcelain", "--untracked-files=all"], directory).trim();
    if (afterInstall) throw new Error(`Frozen install modified the clean worktree:\n${afterInstall}`);
    executeShell(config.buildCommand, webRoot, {
      CI: "1",
      NODE_ENV: "production",
      MATCHDAY_PHASE2_DATA_MODE: "",
      VERCEL_GIT_COMMIT_REF: gateCBranch,
      VERCEL_GIT_PREVIOUS_SHA: sha,
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
