import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function lockPathFor(worktreePath) {
  const identifier = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(tmpdir(), `matchday-playwright-${identifier}.lock`);
}

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
    if (typeof owner.pid !== "number" || typeof owner.worktreePath !== "string") return null;
    return { pid: owner.pid, worktreePath: owner.worktreePath };
  } catch {
    return null;
  }
}

export function acquirePlaywrightWorktreeLock(worktreePath, { pid = process.pid } = {}) {
  const lockPath = lockPathFor(worktreePath);
  const owner = { pid, worktreePath };
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(owner));
    closeSync(descriptor);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    const existingOwner = readOwner(lockPath);
    if (existingOwner && !processIsAlive(existingOwner.pid)) {
      unlinkSync(lockPath);
      return acquirePlaywrightWorktreeLock(worktreePath, { pid });
    }
    const ownerDescription = existingOwner ? ` (PID ${existingOwner.pid})` : "";
    throw new Error(
      `Another Playwright run already owns this worktree${ownerDescription}. ` +
        "Wait for it to finish before starting another run so its Next.js build output and local ports remain isolated.",
    );
  }
  return () => {
    if (!existsSync(lockPath)) return;
    if (readOwner(lockPath)?.pid === pid) unlinkSync(lockPath);
  };
}
