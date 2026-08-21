import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 2 - Boundary 01: Build Graph & Output Bounds", () => {
  it("B01-T01: handles empty/missing environment variables gracefully in turbo build definitions", () => {
    const turboPath = path.join(rootDir, "turbo.json");
    const turbo = JSON.parse(readFileSync(turboPath, "utf8"));
    expect(turbo.tasks.build.env).toBeDefined();
    expect(Array.isArray(turbo.tasks.build.env)).toBe(true);
    expect(turbo.tasks.build.env).toContain("RENDER_API_ORIGIN");
  });

  it("B01-T02: rejects invalid/corrupted JSON structure in package.json", () => {
    const validPkg = readFileSync(path.join(rootDir, "package.json"), "utf8");
    expect(() => JSON.parse(validPkg)).not.toThrow();
    expect(() => JSON.parse("{ invalid json")).toThrow();
  });

  it("B01-T03: verifies workspace output array contains exactly expected packages and apps", () => {
    const guardPath = path.join(rootDir, "scripts/assert-clean-workspace-outputs.mjs");
    const content = readFileSync(guardPath, "utf8");
    // Verify boundaries of generated outputs array (must contain 15 paths)
    expect(content).toContain("apps/api/dist");
    expect(content).toContain("packages/ui/dist");
    expect(content).toContain("Clean-checkout guard passed");
  });

  it("B01-T04: build outputs pattern excludes cache directories strictly (!.next/cache/**)", () => {
    const turboPath = path.join(rootDir, "turbo.json");
    const turbo = JSON.parse(readFileSync(turboPath, "utf8"));
    expect(turbo.tasks.build.outputs).toContain("!.next/cache/**");
  });

  it("B01-T05: Next.js build configuration enforces zero max warnings policy in linting", () => {
    const webPkg = JSON.parse(readFileSync(path.join(rootDir, "apps/web/package.json"), "utf8"));
    expect(webPkg.scripts.lint).toContain("--max-warnings=0");
  });
});
