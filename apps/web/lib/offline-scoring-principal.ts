"use client";

const SCORING_PRINCIPAL_COOKIE = "matchday_scoring_principal";
const PRINCIPAL_PATTERN = /^[0-9a-f]{64}$/;
// Modern browsers cap persistent cookies at 400 days. Renew the non-secret
// principal binding on every successful recovery so unresolved queues do not
// become inaccessible at the 30-day terminal-queue pruning boundary.
const OFFLINE_PRINCIPAL_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000;

export function readScoringPrincipalCookie(cookieHeader: string = document.cookie): string | null {
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SCORING_PRINCIPAL_COOKIE}=`))
    ?.slice(SCORING_PRINCIPAL_COOKIE.length + 1);
  if (!encoded) return null;
  try {
    const principal = decodeURIComponent(encoded);
    return PRINCIPAL_PATTERN.test(principal) ? principal : null;
  } catch {
    return null;
  }
}

export function retainScoringPrincipalCookie(principalId: string, expiresAt: string): void {
  if (!PRINCIPAL_PATTERN.test(principalId)) throw new Error("Scoring principal is invalid.");
  const authorityExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(authorityExpiry)) throw new Error("Scoring principal expiry is invalid.");
  // The opaque binding must outlive authority expiry so the same browser
  // profile can still inspect or export an unresolved terminal queue. Explicit
  // sign-out and a confirmed principal switch clear or rotate it.
  const retentionExpiry = Math.max(authorityExpiry, Date.now() + OFFLINE_PRINCIPAL_RETENTION_MS);
  document.cookie = `${SCORING_PRINCIPAL_COOKIE}=${encodeURIComponent(principalId)}; Path=/score; Expires=${new Date(retentionExpiry).toUTCString()}; Secure; SameSite=Strict`;
}

export function clearScoringPrincipalCookie(): void {
  document.cookie = `${SCORING_PRINCIPAL_COOKIE}=; Path=/score; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict`;
}
