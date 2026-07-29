"use client";

const SCORING_PRINCIPAL_COOKIE = "matchday_scoring_principal";
const PRINCIPAL_PATTERN = /^[0-9a-f]{64}$/;

export function readScoringPrincipalCookie(cookieHeader: string = document.cookie): string | null {
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SCORING_PRINCIPAL_COOKIE}=`))
    ?.slice(SCORING_PRINCIPAL_COOKIE.length + 1);
  if (!encoded) return null;
  const principal = decodeURIComponent(encoded);
  return PRINCIPAL_PATTERN.test(principal) ? principal : null;
}

export function retainScoringPrincipalCookie(principalId: string, expiresAt: string): void {
  if (!PRINCIPAL_PATTERN.test(principalId)) throw new Error("Scoring principal is invalid.");
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Scoring principal expiry is invalid.");
  document.cookie = `${SCORING_PRINCIPAL_COOKIE}=${encodeURIComponent(principalId)}; Path=/score; Expires=${new Date(expiry).toUTCString()}; Secure; SameSite=Strict`;
}

export function clearScoringPrincipalCookie(): void {
  document.cookie = `${SCORING_PRINCIPAL_COOKIE}=; Path=/score; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict`;
}
