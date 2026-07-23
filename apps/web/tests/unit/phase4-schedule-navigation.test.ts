import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(webRoot, relativePath), "utf8");
}

describe("Phase 4 schedule navigation integrity", () => {
  it("forbids destructive document reloads in successful schedule mutations", async () => {
    const files = await Promise.all([
      source("components/phase4/schedule/ScheduleWorkspace.tsx"),
      source("components/phase4/schedule/ScheduleMoveFlow.tsx"),
    ]);
    for (const content of files) {
      expect(content).not.toMatch(/window\.location\.(?:reload|assign)\s*\(/u);
      expect(content).not.toMatch(/location\.(?:reload|assign)\s*\(/u);
    }
  });

  it("uses authoritative refresh and semantic route replacement", async () => {
    const workspace = await source("components/phase4/schedule/ScheduleWorkspace.tsx");
    const refresh = await source("components/phase4/schedule/use-preserved-router-refresh.ts");
    const move = await source("components/phase4/schedule/ScheduleMoveFlow.tsx");
    expect(workspace).toContain("usePreservedRouterRefresh");
    expect(refresh).toContain("router.refresh()");
    expect(refresh).toContain("focus({ preventScroll: true })");
    expect(move).toContain("router.replace(");
    expect(move).toContain("storeScheduleNavigationAnnouncement");
  });
});
