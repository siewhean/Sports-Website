import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const genericConfig = path.resolve(process.cwd(), "playwright.config.ts");

describe("generic Playwright fixture routing", () => {
  it("keeps V1 real-API journeys in their isolated-state runners", async () => {
    const source = await readFile(genericConfig, "utf8");

    expect(source).toContain('"**/v1-real-api.spec.ts"');
    expect(source).toContain('"**/v1-competition-real-api.spec.ts"');
  });
});

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const gateDSpecs = [
  "phase-7-multi-division-lifecycle.spec.ts",
  "phase-7-sch006-official-lifecycle.spec.ts",
  "phase-7-security-rendering.spec.ts",
];

it("collects Gate D real-stack specs only in their production-backed runner", async () => {
  const collect = async (config: string) => {
    const { stdout } = await run(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", "--config", config, "--list", "--reporter=list"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PHASE7_E2E_WEB_BASE_URL: "http://127.0.0.1:3000" },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return stdout;
  };
  const [ordinary, gateD] = await Promise.all([
    collect("playwright.config.ts"),
    collect("playwright.gate-d.config.ts"),
  ]);
  for (const spec of gateDSpecs) {
    expect(ordinary).not.toContain(spec);
    expect(gateD).toContain(spec);
  }
  expect(gateD.match(/phase-7-sch006-official-lifecycle\.spec\.ts:/g)).toHaveLength(3);
  expect(gateD).toContain("Total: 5 tests in 3 files");
}, 30_000);
