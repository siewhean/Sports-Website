import { describe, expect, it } from "vitest";
import { requireWriterAccessExchange, type AccessExchange } from "../../scripts/lib/qa011-access-contract.js";

describe("QA-011 access exchange contract", () => {
  it("accepts only the production writer access-exchange contract", () => {
    expect(
      requireWriterAccessExchange(
        {
          match_id: "match-1",
          mode: "writer",
          session_id: "session-1",
          session_token: "session-token-1",
          generation: 1,
        },
        "match-1",
      ),
    ).toEqual({ sessionId: "session-1", sessionToken: "session-token-1", generation: 1 });
  });

  it("rejects the legacy writer_generation-only response", () => {
    expect(() =>
      requireWriterAccessExchange(
        {
          match_id: "match-1",
          session_id: "session-1",
          session_token: "session-token-1",
          writer_generation: 1,
        } as unknown as AccessExchange,
        "match-1",
      ),
    ).toThrow(/required writer session contract/);
  });

  it("rejects non-writer, mismatched-match, and invalid-generation exchanges", () => {
    for (const response of [
      { match_id: "match-1", mode: "candidate", session_id: "s", session_token: "t", generation: null },
      { match_id: "different-match", mode: "writer", session_id: "s", session_token: "t", generation: 1 },
      { match_id: "match-1", mode: "writer", session_id: "s", session_token: "t", generation: 0 },
    ]) {
      expect(() => requireWriterAccessExchange(response, "match-1")).toThrow(/required writer session contract/);
    }
  });
});
