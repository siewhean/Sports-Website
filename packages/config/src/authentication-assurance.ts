export type AuthenticationAssurancePolicyConfig = {
  minimum: "off" | "mfa" | "phishing_resistant";
  maxAuthenticationAgeMs?: number;
};

const allowed = new Set<AuthenticationAssurancePolicyConfig["minimum"]>(["off", "mfa", "phishing_resistant"]);

export function parseAuthenticationAssurancePolicy(
  value: string | undefined,
  maximumAgeSeconds: string | undefined,
): AuthenticationAssurancePolicyConfig {
  const minimum = (value ?? "off") as AuthenticationAssurancePolicyConfig["minimum"];
  if (!allowed.has(minimum)) throw new Error("Invalid authentication assurance policy");
  if (!maximumAgeSeconds) return { minimum };
  const seconds = Number(maximumAgeSeconds);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new Error("Invalid authentication assurance maximum age");
  }
  if (minimum === "off") throw new Error("Authentication freshness requires an enabled policy");
  return { minimum, maxAuthenticationAgeMs: seconds * 1_000 };
}
