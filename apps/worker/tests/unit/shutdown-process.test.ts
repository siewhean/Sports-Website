import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

const telemetryUrl = new URL("../../src/telemetry.ts", import.meta.url).href;
const emailWorkerUrl = new URL("../../src/email-outbox-worker.ts", import.meta.url).href;

// Run the actual lifecycle and polling classes in a separate Node process. A
// retained handle and stalled initial claim ensure termination is caused by
// process.exit, not by mocked exit callbacks or an empty event loop.
async function signalStalledStartup(signal: "SIGTERM" | "SIGINT") {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { createWorkerShutdown, createWorkerSignalShutdown } from ${JSON.stringify(telemetryUrl)};
        import { EmailOutboxPollingWorker } from ${JSON.stringify(emailWorkerUrl)};
        setInterval(() => {}, 10000);
        const events = [];
        const worker = new EmailOutboxPollingWorker({
          processor: { processDue: () => new Promise(() => {}) },
          pollIntervalMs: 1000,
          batchSize: 1,
        });
        const stop = createWorkerShutdown({
          stopBackgroundIntake: () => { events.push('intake'); worker.requestStop(); },
          drain: async () => { events.push('drain'); },
          closeBackground: () => { events.push('background'); return worker.stop(); },
          telemetry: {
            flush: async () => { events.push('flush'); },
            shutdown: async () => { events.push('telemetry'); },
          },
        });
        const shutdown = createWorkerSignalShutdown({
          stop,
          deadlineMs: 1000,
          onRequested: () => events.push('requested'),
          onStopped: () => events.push('stopped'),
          onFailed: () => events.push('failed'),
          onDeadlineExceeded: () => events.push('deadline'),
          flushLogger: () => { events.push('logger'); console.log(JSON.stringify(events)); },
          exit: code => process.exit(code),
        });
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.send('ready');
        await worker.start();
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  let errors = "";
  child.stdout!.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr!.on("data", (data: Buffer) => (errors += data.toString()));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<{ code: number | null; signal: string | null; output: string; errors: string }>(
      (resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Stalled worker process did not terminate")), 5_000);
        child.once("error", reject);
        child.once("message", () => child.kill(signal));
        child.once("close", (code, terminationSignal) => resolve({ code, signal: terminationSignal, output, errors }));
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe("real worker process shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits non-zero within the deadline during stalled startup on %s",
    async (signal) => {
      const result = await signalStalledStartup(signal);
      expect(result.errors).toBe("");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.output.trim())).toEqual([
        "requested",
        "intake",
        "drain",
        "background",
        "deadline",
        "logger",
      ]);
    },
  );
});
