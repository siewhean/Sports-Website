import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquirePlaywrightSharedPortLock,
  acquirePlaywrightWorktreeLock,
} from "../helpers/playwright-worktree-lock.mjs";

const worktrees: string[] = [];

afterEach(() => {
  for (const worktree of worktrees.splice(0)) rmSync(worktree, { recursive: true, force: true });
});

describe("Playwright worktree lock", () => {
  it("rejects a concurrent runner before it can share ports or build output", () => {
    const worktree = mkdtempSync(join(tmpdir(), "matchday-playwright-lock-"));
    worktrees.push(worktree);
    const release = acquirePlaywrightWorktreeLock(worktree);

    expect(() => acquirePlaywrightWorktreeLock(worktree)).toThrow("Another Playwright run already owns this worktree");

    release();
    const secondRelease = acquirePlaywrightWorktreeLock(worktree);
    secondRelease();
  });

  it("rejects a second worktree while the fixed server ports are in use", () => {
    const firstWorktree = mkdtempSync(join(tmpdir(), "matchday-playwright-first-"));
    const secondWorktree = mkdtempSync(join(tmpdir(), "matchday-playwright-second-"));
    worktrees.push(firstWorktree, secondWorktree);
    const release = acquirePlaywrightSharedPortLock(firstWorktree);

    expect(() => acquirePlaywrightSharedPortLock(secondWorktree)).toThrow(
      "Another Playwright run already owns the shared Playwright ports",
    );

    release();
    const secondRelease = acquirePlaywrightSharedPortLock(secondWorktree);
    secondRelease();
  });

  it("routes every shared-port Playwright config through the locked server launcher", () => {
    for (const configName of ["playwright.config.ts", "playwright.format-designer.config.ts"]) {
      const source = readFileSync(new URL(`../../${configName}`, import.meta.url), "utf8");
      expect(source).toContain("tests/helpers/run-playwright-web-server.mjs");
      expect(source).toContain("reuseExistingServer: false");
    }

    const launcher = readFileSync(new URL("../helpers/run-playwright-web-server.mjs", import.meta.url), "utf8");
    expect(launcher).not.toContain("detached: true");
  });
});
