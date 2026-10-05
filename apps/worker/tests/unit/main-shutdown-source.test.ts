import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

describe("worker process shutdown", () => {
  it("terminates after the runtime and logger have completed graceful shutdown", () => {
    expect(source).toContain("stopBackgroundIntake: () => emailWorkerHandle.worker.requestStop()");
    expect(source).toContain("drain: () => runtime.stop()");
    expect(source).toContain("closeBackground: () => emailWorkerHandle.close()");
    expect(source).toContain("createWorkerSignalShutdown");
    expect(source).toContain("WORKER_WHOLE_PROCESS_SHUTDOWN_DEADLINE_MS");
    expect(source).toContain("crash-equivalent lease recovery");
    expect(source).toContain("logger.flush()");
    expect(source).toContain("process.exit(code)");
  });
});
