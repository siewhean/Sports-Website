import type { AuthenticationAssuranceMinimum, AuthenticationAssurancePolicy } from "@matchday/identity";

const allowed = new Set<AuthenticationAssuranceMinimum>(["off", "mfa", "phishing_resistant"]);

export function parseAuthenticationAssurancePolicy(
  value: string | undefined,
  maximumAgeSeconds: string | undefined,
): AuthenticationAssurancePolicy {
  const minimum = (value ?? "off") as AuthenticationAssuranceMinimum;
  if (!allowed.has(minimum)) throw new Error("Invalid authentication assurance policy");
  if (!maximumAgeSeconds) return { minimum };
  const seconds = Number(maximumAgeSeconds);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new Error("Invalid authentication assurance maximum age");
  }
  if (minimum === "off") throw new Error("Authentication freshness requires an enabled policy");
  return { minimum, maxAuthenticationAgeMs: seconds * 1_000 };
}
