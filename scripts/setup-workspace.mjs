import { chmod, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const hook = new URL("../.githooks/pre-commit", import.meta.url);
await access(hook);
await chmod(hook, 0o755);

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});

if (result.status !== 0) {
  throw new Error(result.stderr || "Unable to configure Git hooks");
}

console.log("Workspace hooks configured. Run `pnpm check` before pushing.");
