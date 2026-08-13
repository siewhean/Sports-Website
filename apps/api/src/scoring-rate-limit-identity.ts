import { createHash, timingSafeEqual } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";

function secretHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve only a trusted identity for rate-limit partitioning. This is not an
 * authorization decision: scoring routes still perform their normal match,
 * permission, writer-generation, lease, and competition checks afterwards.
 */
export async function verifiedScoringRateLimitSessionId(
  sql: PostgresJsSql,
  sessionId: string,
  sessionToken: string,
  now = new Date(),
): Promise<string | null> {
  const rows = await sql.unsafe<{
    id: string;
    session_token_hash: Buffer;
    expires_at: Date | string;
    revoked_at: Date | string | null;
    competition_status: string;
  }>(
    `SELECT s.id,s.session_token_hash,s.expires_at,s.revoked_at,c.status AS competition_status
     FROM scoring_access_sessions s
     JOIN competitions c ON c.id=s.competition_id
     WHERE s.id=$1
     LIMIT 1`,
    [sessionId],
  );
  const session = rows[0];
  if (!session || !equalHash(Buffer.from(session.session_token_hash), secretHash(sessionToken))) return null;
  if (session.revoked_at || session.competition_status === "archived") return null;
  const expiresAt = session.expires_at instanceof Date ? session.expires_at : new Date(session.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return null;
  return session.id;
}
