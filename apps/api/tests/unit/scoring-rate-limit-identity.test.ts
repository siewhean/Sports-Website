import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import {
  anonymousRateLimitKey,
  scoringSessionRateLimitKey,
  verifiedScoringRateLimitSessionId,
} from "../../src/scoring-rate-limit-identity.js";

const now = new Date("2026-08-14T00:00:00.000Z");
const sessionId = "00000000-0000-4000-8000-000000000001";
const sessionToken = "t".repeat(43);

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sqlWithRow(
  row:
    | {
        id: string;
        session_token_hash: Buffer;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        competition_status: string;
      }
    | undefined,
): PostgresJsSql {
  return {
    unsafe: async () => (row ? [row] : []),
  } as unknown as PostgresJsSql;
}

function activeRow() {
  return {
    id: sessionId,
    session_token_hash: tokenHash(sessionToken),
    expires_at: new Date(now.getTime() + 60_000),
    revoked_at: null,
    competition_status: "active",
  };
}

describe("scoring rate-limit identity", () => {
  it("derives deterministic HMAC keys without embedding the raw session id or IP", () => {
    const secret = "dedicated-scoring-rate-limit-hmac-secret";
    const ip = "198.51.100.220";

    const anonymous = anonymousRateLimitKey(ip, secret);
    const scoring = scoringSessionRateLimitKey(sessionId, ip, secret);

    expect(anonymous).toBe(anonymousRateLimitKey(ip, secret));
    expect(scoring).toBe(scoringSessionRateLimitKey(sessionId, ip, secret));
    expect(anonymous).not.toContain(ip);
    expect(scoring).not.toContain(ip);
    expect(scoring).not.toContain(sessionId);
    expect(scoring).not.toBe(scoringSessionRateLimitKey(sessionId, ip, `${secret}-different`));
  });

  it("returns only an active server-verified scoring session id", async () => {
    await expect(
      verifiedScoringRateLimitSessionId(sqlWithRow(activeRow()), sessionId, sessionToken, now),
    ).resolves.toBe(sessionId);
  });

  it("fails closed for missing, wrong-token, revoked, expired, and archived sessions", async () => {
    await expect(verifiedScoringRateLimitSessionId(sqlWithRow(undefined), sessionId, sessionToken, now)).resolves.toBe(
      null,
    );
    await expect(
      verifiedScoringRateLimitSessionId(sqlWithRow(activeRow()), sessionId, "x".repeat(43), now),
    ).resolves.toBe(null);
    await expect(
      verifiedScoringRateLimitSessionId(
        sqlWithRow({ ...activeRow(), revoked_at: new Date(now.getTime() - 1_000) }),
        sessionId,
        sessionToken,
        now,
      ),
    ).resolves.toBe(null);
    await expect(
      verifiedScoringRateLimitSessionId(
        sqlWithRow({ ...activeRow(), expires_at: new Date(now.getTime() - 1) }),
        sessionId,
        sessionToken,
        now,
      ),
    ).resolves.toBe(null);
    await expect(
      verifiedScoringRateLimitSessionId(
        sqlWithRow({ ...activeRow(), competition_status: "archived" }),
        sessionId,
        sessionToken,
        now,
      ),
    ).resolves.toBe(null);
  });
});
