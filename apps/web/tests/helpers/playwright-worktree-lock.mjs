import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function lockPathFor(worktreePath) {
  const identifier = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(tmpdir(), `matchday-playwright-${identifier}.lock`);
}

function sharedPortLockPath() {
  return join(tmpdir(), "matchday-playwright-shared-ports.lock");
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

function acquireLock(lockPath, owner, description, { pid = process.pid } = {}) {
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(owner));
    closeSync(descriptor);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    const existingOwner = readOwner(lockPath);
    if (existingOwner && !processIsAlive(existingOwner.pid)) {
      unlinkSync(lockPath);
      return acquireLock(lockPath, owner, description, { pid });
    }
    const ownerDescription = existingOwner ? ` (PID ${existingOwner.pid})` : "";
    throw new Error(
      `Another Playwright run already owns ${description}${ownerDescription}. ` +
        "Wait for it to finish before starting another run so its Next.js build output and local ports remain isolated.",
    );
  }
  return () => {
    if (!existsSync(lockPath)) return;
    if (readOwner(lockPath)?.pid === pid) unlinkSync(lockPath);
  };
}

export function acquirePlaywrightWorktreeLock(worktreePath, { pid = process.pid } = {}) {
  return acquireLock(lockPathFor(worktreePath), { pid, worktreePath }, "this worktree", { pid });
}

/**
 * The shared launcher binds fixed HTTPS/HTTP ports. This lock prevents a
 * different worktree from accidentally serving its build to this test run.
 */
export function acquirePlaywrightSharedPortLock(worktreePath, { pid = process.pid } = {}) {
  return acquireLock(sharedPortLockPath(), { pid, worktreePath }, "the shared Playwright ports", { pid });
}
