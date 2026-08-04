import { spawn } from "node:child_process";

import { acquirePlaywrightWorktreeLock } from "./playwright-worktree-lock.mjs";

const release = acquirePlaywrightWorktreeLock(process.cwd());
const shouldBuild = process.env.MATCHDAY_PLAYWRIGHT_SKIP_BUILD !== "1";
const environment =
  `APP_ENV=local MATCHDAY_PHASE2_DATA_MODE=demo MATCHDAY_ALLOW_DEMO_FIXTURES=1 ` +
  `MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE=${process.env.MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE ?? ""}`;
const buildStep = shouldBuild ? `${environment} pnpm build && ` : "";
const serverCommand = `trap 'exit 0' INT TERM; ${buildStep}(${environment} pnpm start --hostname 127.0.0.1 --port 3101 & next_pid=$!; trap 'kill $next_pid 2>/dev/null || true' EXIT INT TERM; node tests/helpers/https-proxy.mjs)`;
const server = spawn("sh", ["-c", serverCommand], { stdio: "inherit", env: process.env });
const outcome = await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.once("exit", (code, signal) => resolve({ code, signal }));
});

release();
if (outcome.signal) process.exitCode = 1;
else process.exitCode ??= outcome.code ?? 1;
