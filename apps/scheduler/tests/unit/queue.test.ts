import { describe, expect, it } from "vitest";

import { assertScheduleQueuePayload } from "../../src/queue.js";
import { queuePayload } from "../fixtures.js";

describe("assertScheduleQueuePayload", () => {
  it("accepts the exact reference-only payload", () => {
    expect(() => assertScheduleQueuePayload(queuePayload())).not.toThrow();
  });

  it.each([
    ["unknown field", { ...queuePayload(), secret: "must-not-enter-redis" }],
    ["job UUID", { ...queuePayload(), jobId: "job-1" }],
    ["competition UUID", { ...queuePayload(), competitionId: "competition-1" }],
    ["hash", { ...queuePayload(), inputHash: "bad" }],
    ["correlation controls", { ...queuePayload(), correlationId: "bad\nvalue" }],
  ])("rejects %s", (_label, value) => {
    expect(() => assertScheduleQueuePayload(value)).toThrow("Invalid schedule queue payload");
  });
});
