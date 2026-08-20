import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../../..");

describe("clean deployment build topology guard", () => {
  const turboJson = JSON.parse(readFileSync(path.join(rootDir, "turbo.json"), "utf8"));
  const webPackageJson = JSON.parse(readFileSync(path.join(rootDir, "apps/web/package.json"), "utf8"));

  it("ensures build task depends on workspace dependency builds", () => {
    expect(turboJson.tasks.build).toBeDefined();
    expect(turboJson.tasks.build.dependsOn).toContain("^build");
  });

  it("does not hardcode partial manual workspace builds in apps/web prebuild or predev", () => {
    expect(webPackageJson.scripts.predev).toBeUndefined();
    expect(webPackageJson.scripts.prebuild).not.toContain("pnpm --filter");
    expect(webPackageJson.scripts.build).toBe("next build");
  });

  it("verifies all workspace dependencies of apps/web have build tasks", () => {
    const webDeps = {
      ...webPackageJson.dependencies,
      ...webPackageJson.devDependencies,
    };

    const workspaceDeps = Object.entries(webDeps)
      .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
      .map(([name]) => name);

    expect(workspaceDeps).toContain("@matchday/domain");
    expect(workspaceDeps).toContain("@matchday/contracts");
    expect(workspaceDeps).toContain("@matchday/ui");
    expect(workspaceDeps).toContain("@matchday/feature-flags");

    for (const dep of workspaceDeps) {
      const pkgPath = dep.replace("@matchday/", "packages/");
      const pkgJsonPath = path.join(rootDir, pkgPath, "package.json");
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      expect(pkgJson.scripts?.build, `Workspace package ${dep} must define a build script`).toBeDefined();
    }
  });
});
