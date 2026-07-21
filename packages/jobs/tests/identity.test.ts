import { describe, expect, it } from "vitest";

import { DurableJobQueue } from "../src/durable-job-queue.js";
import { createDeterministicJobId } from "../src/identity.js";
import type { JobDefinition } from "../src/types.js";

type SerializationJobs = {
  probe: JobDefinition<{ value: number }, void>;
};

describe("createDeterministicJobId", () => {
  it("returns the same Redis-safe ID for the same operation", () => {
    const first = createDeterministicJobId("email.delivery", "delivery-42");
    const second = createDeterministicJobId("email.delivery", "delivery-42");

    expect(first).toBe(second);
    expect(first).toMatch(/^job-[a-f0-9]{64}$/u);
    expect(first).not.toContain(":");
  });

  it("namespaces identical business keys by job type", () => {
    expect(createDeterministicJobId("email.delivery", "42")).not.toBe(
      createDeterministicJobId("notification.delivery", "42"),
    );
  });

  it("rejects empty and unbounded keys", () => {
    expect(() => createDeterministicJobId("probe", "")).toThrow(/idempotencyKey/u);
    expect(() => createDeterministicJobId("probe", "x".repeat(257))).toThrow(/idempotencyKey/u);
  });
});

describe("DurableJobQueue secret retention", () => {
  it("does not expose Redis credentials through serialization", async () => {
    const password = "jobs-redis-password-must-not-serialize";
    const queue = new DurableJobQueue<SerializationJobs>({
      queueName: "serialization-regression",
      connection: { host: "127.0.0.1", port: 6379, password, maxRetriesPerRequest: null },
    });

    try {
      expect(JSON.stringify(queue)).not.toContain(password);
    } finally {
      await queue.close();
    }
  });
});
