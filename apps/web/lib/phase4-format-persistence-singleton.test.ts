import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));

describe("Phase 4 format persistence ownership", () => {
  it("defines formatSaveBody in exactly one authoritative module", async () => {
    const files = (await readdir(directory)).filter(
      (name) => name.startsWith("phase4-") && name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const owners: string[] = [];
    for (const name of files) {
      const source = await readFile(path.join(directory, name), "utf8");
      if (/\b(?:export\s+)?function\s+formatSaveBody\s*\(/u.test(source)) owners.push(name);
    }
    expect(owners).toEqual(["phase4-format-persistence.ts"]);
  });
});
