export function acquirePlaywrightWorktreeLock(worktreePath: string, options?: { pid?: number }): () => void;
export function acquirePlaywrightSharedPortLock(worktreePath: string, options?: { pid?: number }): () => void;
