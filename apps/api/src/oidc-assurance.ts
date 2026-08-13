import { IdentityError, type ProviderAuthenticationAssurance } from "@matchday/identity";

function invalid(): never {
  throw new IdentityError("AUTHENTICATION_FAILED", "Authentication could not be completed.");
}

export function readOidcAssurance(
  claims: Readonly<Record<string, unknown>>,
  strongClaimName?: string,
  now = new Date(),
): ProviderAuthenticationAssurance {
  const rawMethods = claims.amr;
  let methods: string[] = [];
  if (rawMethods !== undefined) {
    if (!Array.isArray(rawMethods) || rawMethods.length > 16) invalid();
    methods = rawMethods.map((value) => {
      if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
        invalid();
      }
      return value;
    });
  }
  methods = [...new Set(methods)];

  const rawAcr = claims.acr;
  if (rawAcr !== undefined && (typeof rawAcr !== "string" || rawAcr.length > 512 || /[\u0000-\u001f\u007f]/.test(rawAcr))) {
    invalid();
  }
  const acr = typeof rawAcr === "string" ? rawAcr : null;

  const rawTime = claims.auth_time;
  let authenticatedAt: Date | null = null;
  if (rawTime !== undefined) {
    if (typeof rawTime !== "number" || !Number.isSafeInteger(rawTime) || rawTime < 0) invalid();
    authenticatedAt = new Date(rawTime * 1_000);
    if (!Number.isFinite(authenticatedAt.getTime()) || authenticatedAt.getTime() > now.getTime() + 300_000) invalid();
  }

  let phishingResistant = false;
  if (strongClaimName) {
    const rawStrong = claims[strongClaimName];
    if (rawStrong !== undefined && typeof rawStrong !== "boolean") invalid();
    phishingResistant = rawStrong === true;
  }
  if (phishingResistant && !methods.includes("mfa")) invalid();

  return { methods, acr, authenticatedAt, phishingResistant };
}
