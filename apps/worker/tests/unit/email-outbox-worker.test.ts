import { describe, expect, it, vi } from "vitest";

import { createProductionEmailOutboxWorker, EmailOutboxPollingWorker } from "../../src/email-outbox-worker.js";

describe("EmailOutboxPollingWorker", () => {
  it("processes an initial batch and waits for it during shutdown", async () => {
    let resolveBatch: (() => void) | undefined;
    const processDue = vi.fn(
      () =>
        new Promise<{ claimed: number; delivered: number; retried: number; deadLettered: number }>((resolve) => {
          resolveBatch = () => resolve({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0 });
        }),
    );
    const worker = new EmailOutboxPollingWorker({
      processor: { processDue },
      pollIntervalMs: 1_000,
      batchSize: 25,
    });

    const started = worker.start();
    const stopped = worker.stop();
    expect(processDue).toHaveBeenCalledWith(25);
    let stoppedBeforeBatch = false;
    void stopped.then(() => {
      stoppedBeforeBatch = true;
    });
    await Promise.resolve();
    expect(stoppedBeforeBatch).toBe(false);

    resolveBatch?.();
    await Promise.all([started, stopped]);
  });

  it("reports polling errors and keeps the worker alive", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const processDue = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const worker = new EmailOutboxPollingWorker({
      processor: { processDue },
      pollIntervalMs: 1_000,
      batchSize: 10,
      onError,
    });

    await worker.start();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "database unavailable" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processDue).toHaveBeenCalledTimes(2);
    await worker.stop();
    vi.useRealTimers();
  });

  it("rejects unbounded polling settings", () => {
    expect(
      () =>
        new EmailOutboxPollingWorker({
          processor: { processDue: async () => ({ claimed: 0, delivered: 0, retried: 0, deadLettered: 0 }) },
          pollIntervalMs: 999,
          batchSize: 25,
        }),
    ).toThrow("at least 1000ms");
  });

  it("composes production worker and rejects invalid SMTP configuration fail-closed", async () => {
    // Missing host
    expect(() =>
      createProductionEmailOutboxWorker({
        databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
        smtp: {
          host: "",
          port: 587,
          secure: true,
          from: "Matchday <no-reply@matchday.test>",
        },
      }),
    ).toThrow("SMTP host is required");

    // Invalid port
    expect(() =>
      createProductionEmailOutboxWorker({
        databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
        smtp: {
          host: "smtp.example.test",
          port: 0,
          secure: true,
          from: "Matchday <no-reply@matchday.test>",
        },
      }),
    ).toThrow("SMTP port must be between 1 and 65535");

    // Missing from
    expect(() =>
      createProductionEmailOutboxWorker({
        databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
        smtp: {
          host: "smtp.example.test",
          port: 587,
          secure: true,
          from: "",
        },
      }),
    ).toThrow("SMTP from address is required");

    // Valid composition
    const handle = createProductionEmailOutboxWorker({
      databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
      smtp: {
        host: "127.0.0.1",
        port: 1025,
        secure: false,
        from: "Matchday <no-reply@matchday.test>",
      },
      pollIntervalMs: 2_000,
      batchSize: 10,
    });
    expect(handle.worker).toBeInstanceOf(EmailOutboxPollingWorker);
    await handle.close();
  });
});
