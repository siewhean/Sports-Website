import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

describe("worker process shutdown", () => {
  it("terminates after the runtime and logger have completed graceful shutdown", () => {
    expect(source).toContain("await runtime.stop()");
    expect(source).toContain("logger.flush()");
    expect(source).toContain("process.exit(forceExit ? 1 : 0)");
  });
});
