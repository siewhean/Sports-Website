import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 01: Workspace Build Graph & Clean Build Guard", () => {
  it("F01-T01: turbo.json declares topological build pipeline with ^build dependsOn", () => {
    const turboPath = path.join(rootDir, "turbo.json");
    expect(existsSync(turboPath)).toBe(true);
    const turboConfig = JSON.parse(readFileSync(turboPath, "utf8"));
    expect(turboConfig.tasks.build).toBeDefined();
    expect(turboConfig.tasks.build.dependsOn).toContain("^build");
    expect(turboConfig.tasks.build.outputs).toContain("dist/**");
    expect(turboConfig.tasks.build.outputs).toContain(".next/**");
  });

  it("F01-T02: root package.json defines monorepo packageManager and engine constraints", () => {
    const pkgPath = path.join(rootDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.packageManager).toMatch(/^pnpm@10\./);
    expect(pkg.engines.node).toBe(">=24.18.0 <25");
    expect(pkg.scripts.build).toBe("turbo run build");
  });

  it("F01-T03: apps/web declares workspace dependencies on core packages with valid build scripts", () => {
    const webPkgPath = path.join(rootDir, "apps/web/package.json");
    const webPkg = JSON.parse(readFileSync(webPkgPath, "utf8"));
    expect(webPkg.dependencies["@matchday/contracts"]).toBe("workspace:*");
    expect(webPkg.dependencies["@matchday/domain"]).toBe("workspace:*");
    expect(webPkg.dependencies["@matchday/ui"]).toBe("workspace:*");
    expect(webPkg.dependencies["@matchday/feature-flags"]).toBe("workspace:*");

    // Verify dependent packages have valid build scripts
    const contractsPkg = JSON.parse(readFileSync(path.join(rootDir, "packages/contracts/package.json"), "utf8"));
    const domainPkg = JSON.parse(readFileSync(path.join(rootDir, "packages/domain/package.json"), "utf8"));
    const uiPkg = JSON.parse(readFileSync(path.join(rootDir, "packages/ui/package.json"), "utf8"));
    const flagsPkg = JSON.parse(readFileSync(path.join(rootDir, "packages/feature-flags/package.json"), "utf8"));

    expect(contractsPkg.scripts.build).toBeDefined();
    expect(domainPkg.scripts.build).toBeDefined();
    expect(uiPkg.scripts.build).toBeDefined();
    expect(flagsPkg.scripts.build).toBeDefined();
  });

  it("F01-T04: clean workspace output guard script exists and targets all build output directories", () => {
    const guardScriptPath = path.join(rootDir, "scripts/assert-clean-workspace-outputs.mjs");
    expect(existsSync(guardScriptPath)).toBe(true);
    const content = readFileSync(guardScriptPath, "utf8");
    expect(content).toContain("generatedOutputs");
    expect(content).toContain("packages/contracts/dist");
    expect(content).toContain("packages/domain/dist");
    expect(content).toContain("apps/web/.next");
  });

  it("F01-T05: clean deployment build guard unit test verifies prebuild script isolation", () => {
    const guardTestPath = path.join(rootDir, "apps/web/tests/unit/clean-deployment-build-guard.test.ts");
    expect(existsSync(guardTestPath)).toBe(true);
    const webPkg = JSON.parse(readFileSync(path.join(rootDir, "apps/web/package.json"), "utf8"));
    // Ensure no brittle pnpm --filter workarounds in prebuild
    if (webPkg.scripts.prebuild) {
      expect(webPkg.scripts.prebuild).not.toContain("pnpm --filter");
    }
  });
});
