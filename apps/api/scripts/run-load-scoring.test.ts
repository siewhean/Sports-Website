import assert from "node:assert/strict";
import test from "node:test";
import { requireWriterAccessExchange, type AccessExchange } from "./lib/qa011-access-contract.js";

test("QA-011 accepts only the production writer access-exchange contract", () => {
  assert.deepEqual(
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
    { sessionId: "session-1", sessionToken: "session-token-1", generation: 1 },
  );
});

test("QA-011 rejects the legacy writer_generation-only response", () => {
  assert.throws(
    () =>
      requireWriterAccessExchange(
        {
          match_id: "match-1",
          session_id: "session-1",
          session_token: "session-token-1",
          writer_generation: 1,
        } as unknown as AccessExchange,
        "match-1",
      ),
    /required writer session contract/,
  );
});

test("QA-011 rejects non-writer, mismatched-match, and invalid-generation exchanges", () => {
  for (const response of [
    { match_id: "match-1", mode: "candidate", session_id: "s", session_token: "t", generation: null },
    { match_id: "different-match", mode: "writer", session_id: "s", session_token: "t", generation: 1 },
    { match_id: "match-1", mode: "writer", session_id: "s", session_token: "t", generation: 0 },
  ]) {
    assert.throws(() => requireWriterAccessExchange(response, "match-1"), /required writer session contract/);
  }
});
