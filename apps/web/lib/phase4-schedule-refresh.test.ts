import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../components/phase4/schedule/ScheduleWorkspace.tsx",
);

describe("Phase 4 schedule mutation refresh", () => {
  it("preserves the workspace instead of using hard page reloads", async () => {
    const source = await readFile(componentPath, "utf8");
    expect(source).not.toMatch(/window\.location\.reload\s*\(/u);
    expect(source).toContain("router.refresh()");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("preventScroll: true");
  });
});
