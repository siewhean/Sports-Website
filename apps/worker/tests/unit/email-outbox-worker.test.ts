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

  it("stops scheduling new email polls immediately when shutdown intake is requested", async () => {
    vi.useFakeTimers();
    const processDue = vi.fn().mockResolvedValue({ claimed: 0, delivered: 0, retried: 0, deadLettered: 0 });
    const worker = new EmailOutboxPollingWorker({
      processor: { processDue },
      pollIntervalMs: 1_000,
      batchSize: 10,
    });

    await worker.start();
    worker.requestStop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processDue).toHaveBeenCalledOnce();
    await worker.stop();
    vi.useRealTimers();
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

  it("rejects shutdown when the batch it waits for fails without stopping normal error recovery", async () => {
    let rejectBatch: ((error: Error) => void) | undefined;
    const onError = vi.fn();
    const worker = new EmailOutboxPollingWorker({
      processor: {
        processDue: () =>
          new Promise((_, reject) => {
            rejectBatch = reject;
          }),
      },
      pollIntervalMs: 1_000,
      batchSize: 1,
      onError,
    });
    const started = worker.start();
    const stopped = worker.stop();
    const error = new Error("database acknowledgement unavailable");
    rejectBatch?.(error);

    await expect(stopped).rejects.toThrow("Email outbox batch failed during shutdown");
    await expect(started).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
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

  it("retains a batch failure after intake stops even if queue drain delays background closure", async () => {
    let rejectBatch: ((error: Error) => void) | undefined;
    const worker = new EmailOutboxPollingWorker({
      processor: {
        processDue: () =>
          new Promise((_, reject) => {
            rejectBatch = reject;
          }),
      },
      pollIntervalMs: 1_000,
      batchSize: 1,
    });
    const started = worker.start();
    worker.requestStop();
    rejectBatch?.(new Error("database acknowledgement unavailable"));
    await started;

    // Production closes background handles only after main queue drain.
    // Repeated signals must not overwrite the completed failure outcome.
    worker.requestStop();
    await expect(worker.stop()).rejects.toThrow("Email outbox batch failed during shutdown");
    await expect(worker.stop()).rejects.toThrow("Email outbox batch failed during shutdown");
  });

  it("closes database handles once and retains application failure when email drain rejects", async () => {
    const handle = createProductionEmailOutboxWorker({
      databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
      smtp: {
        host: "127.0.0.1",
        port: 1025,
        secure: false,
        from: "Matchday <no-reply@matchday.test>",
      },
    });
    const stop = vi.spyOn(handle.worker, "stop").mockRejectedValue(new Error("batch acknowledgement failed"));
    const close = vi.spyOn(handle.sql, "end").mockResolvedValue(undefined);

    const first = handle.close();
    expect(handle.close()).toBe(first);
    await expect(first).rejects.toThrow("batch acknowledgement failed");
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    close.mockRestore();
    await handle.sql.end({ timeout: 1 });
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
    expect(handle.sql.options.connect_timeout).toBe(5);
    expect(handle.sql.options.connection.statement_timeout).toBe(10_000);
    await handle.close();

    expect(() =>
      createProductionEmailOutboxWorker({
        databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
        smtp: {
          host: "127.0.0.1",
          port: 1025,
          secure: false,
          from: "Matchday <no-reply@matchday.test>",
        },
        databaseConnectTimeoutSeconds: 0,
      }),
    ).toThrow("connect timeout");

    expect(() =>
      createProductionEmailOutboxWorker({
        databaseUrl: "postgres://matchday:matchday@127.0.0.1:5432/matchday",
        smtp: {
          host: "127.0.0.1",
          port: 1025,
          secure: false,
          from: "Matchday <no-reply@matchday.test>",
        },
        databaseStatementTimeoutMs: 999,
      }),
    ).toThrow("statement timeout");
  });
});
