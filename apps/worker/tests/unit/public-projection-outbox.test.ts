import { describe, expect, it } from "vitest";

import { parsePublicProjectionOutboxPayload } from "../../src/public-projection-outbox.js";

const competitionId = "10000000-0000-4000-a000-000000000001";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    competition_id: competitionId,
    projection: "results",
    previous_published_version: 3,
    published_version: 4,
    publication_state: "published",
    correlation_id: `edge-purge:${competitionId}:results:3`,
    ...overrides,
  };
}

describe("public projection publication outbox", () => {
  it("maps only a complete published public projection to the worker contract", () => {
    expect(parsePublicProjectionOutboxPayload(payload(), competitionId)).toEqual(payload());
  });

  it.each([
    ["a different aggregate", payload({ competition_id: "20000000-0000-4000-a000-000000000002" })],
    ["a private draft", payload({ publication_state: "draft" })],
    ["a non advancing version", payload({ published_version: 3 })],
    ["a malformed projection", payload({ projection: "all" })],
    ["a malformed correlation id", payload({ correlation_id: "not allowed/" })],
  ])("rejects %s", (_label, value) => {
    expect(() => parsePublicProjectionOutboxPayload(value, competitionId)).toThrow(
      "Malformed public projection outbox payload",
    );
  });
});
