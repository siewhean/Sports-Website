import {
  EmailOutboxProcessor,
  InMemoryEmailOutboxStore,
  createEmailOutboxItem,
  type EmailDeliveryReceipt,
  type EmailMessage,
  type EmailOutboxItem,
  type EmailOutboxStore,
  type EmailProvider,
} from "@matchday/notifications";
import { describe, expect, it, vi } from "vitest";

import { EmailOutboxPollingWorker } from "../../src/email-outbox-worker.js";
import { createWorkerSignalShutdown } from "../../src/telemetry.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MESSAGE: EmailMessage = {
  to: "organiser@example.test",
  subject: "Shutdown test",
  text: "Shutdown test",
  html: "<p>Shutdown test</p>",
  template: { id: "shutdown-test", version: 1 },
  idempotencyKey: "shutdown-email-1",
  notificationId: "shutdown-notification-1",
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deadlineShutdown(stop: () => Promise<void>, exit: ReturnType<typeof vi.fn>) {
  return createWorkerSignalShutdown({
    stop,
    deadlineMs: 1_000,
    onRequested: () => undefined,
    onStopped: () => undefined,
    onFailed: () => undefined,
    onDeadlineExceeded: () => undefined,
    flushLogger: () => undefined,
    exit,
  });
}

async function seededStore(): Promise<InMemoryEmailOutboxStore> {
  const store = new InMemoryEmailOutboxStore();
  await store.enqueue(
    createEmailOutboxItem({
      id: "shutdown-outbox-1",
      message: MESSAGE,
      now: NOW.toISOString(),
    }),
  );
  return store;
}

function processor(
  store: EmailOutboxStore,
  provider: EmailProvider,
  leaseToken: string,
): EmailOutboxProcessor {
  return new EmailOutboxProcessor(store, provider, {
    now: () => new Date(NOW),
    createLeaseToken: () => leaseToken,
  });
}

describe("email shutdown safety", () => {
  it("waits for provider acceptance and delivery acknowledgement before clean exit", async () => {
    const store = await seededStore();
    let accept: ((receipt: EmailDeliveryReceipt) => void) | undefined;
    const provider: EmailProvider = {
      send: () =>
        new Promise<EmailDeliveryReceipt>((resolve) => {
          accept = resolve;
        }),
    };
    const worker = new EmailOutboxPollingWorker({
      processor: processor(store, provider, "normal-delivery-lease"),
      pollIntervalMs: 1_000,
      batchSize: 1,
    });

    void worker.start();
    await flushMicrotasks();

    const exit = vi.fn();
    const shuttingDown = deadlineShutdown(() => worker.stop(), exit)("SIGTERM");
    await flushMicrotasks();
    expect(exit).not.toHaveBeenCalled();

    accept?.({
      providerMessageId: "provider-normal-delivery",
      accepted: [MESSAGE.to],
    });
    await shuttingDown;

    expect(exit).toHaveBeenCalledWith(0);
    expect(await store.findByIdempotencyKey(MESSAGE.idempotencyKey)).toMatchObject({
      status: "delivered",
      leaseToken: null,
      providerMessageId: "provider-normal-delivery",
    });
  });

  it("uses the non-zero whole-process deadline when SMTP never returns", async () => {
    vi.useFakeTimers();
    try {
      const store = await seededStore();
      const send = vi.fn(() => new Promise<EmailDeliveryReceipt>(() => undefined));
      const processDue = vi.fn((limit: number) => processor(store, { send }, "smtp-stall-lease").processDue(limit));
      const worker = new EmailOutboxPollingWorker({
        processor: { processDue },
        pollIntervalMs: 1_000,
        batchSize: 1,
      });

      void worker.start();
      await flushMicrotasks();
      expect(send).toHaveBeenCalledOnce();

      const exit = vi.fn();
      const shuttingDown = deadlineShutdown(() => worker.stop(), exit)("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      await shuttingDown;

      expect(exit).toHaveBeenCalledWith(1);
      expect(processDue).toHaveBeenCalledOnce();
      expect(await store.findByIdempotencyKey(MESSAGE.idempotencyKey)).toMatchObject({
        status: "processing",
        leaseToken: "smtp-stall-lease",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an accepted message leased when database acknowledgement never returns", async () => {
    vi.useFakeTimers();
    try {
      const base = await seededStore();
      let markFailedCalls = 0;
      const store: EmailOutboxStore = {
        enqueue: base.enqueue.bind(base),
        findByIdempotencyKey: base.findByIdempotencyKey.bind(base),
        claimDue: base.claimDue.bind(base),
        markDelivered: () => new Promise<EmailOutboxItem>(() => undefined),
        markFailed: async (...args) => {
          markFailedCalls += 1;
          return base.markFailed(...args);
        },
      };
      const provider: EmailProvider = {
        send: async () => ({
          providerMessageId: "provider-accepted-before-db-stall",
          accepted: [MESSAGE.to],
        }),
      };
      const worker = new EmailOutboxPollingWorker({
        processor: processor(store, provider, "ack-stall-lease"),
        pollIntervalMs: 1_000,
        batchSize: 1,
      });

      void worker.start();
      await flushMicrotasks();
      expect(markFailedCalls).toBe(0);

      const exit = vi.fn();
      const shuttingDown = deadlineShutdown(() => worker.stop(), exit)("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      await shuttingDown;

      expect(exit).toHaveBeenCalledWith(1);
      expect(markFailedCalls).toBe(0);
      expect(await base.findByIdempotencyKey(MESSAGE.idempotencyKey)).toMatchObject({
        status: "processing",
        leaseToken: "ack-stall-lease",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled database claim and never sends without a valid claim", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => ({
        providerMessageId: "must-not-send",
        accepted: [MESSAGE.to],
      }));
      const store: EmailOutboxStore = {
        enqueue: async (item) => item,
        findByIdempotencyKey: async () => null,
        claimDue: () => new Promise<readonly EmailOutboxItem[]>(() => undefined),
        markDelivered: async () => {
          throw new Error("markDelivered must not run without a claim");
        },
        markFailed: async () => {
          throw new Error("markFailed must not run without a claim");
        },
      };
      const worker = new EmailOutboxPollingWorker({
        processor: processor(store, { send }, "claim-stall-lease"),
        pollIntervalMs: 1_000,
        batchSize: 1,
      });

      void worker.start();
      await flushMicrotasks();
      expect(send).not.toHaveBeenCalled();

      const exit = vi.fn();
      const shuttingDown = deadlineShutdown(() => worker.stop(), exit)("SIGINT");
      await vi.advanceTimersByTimeAsync(1_000);
      await shuttingDown;

      expect(exit).toHaveBeenCalledWith(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
