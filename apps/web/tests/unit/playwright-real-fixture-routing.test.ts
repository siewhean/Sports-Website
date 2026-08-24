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
