import { IdentityError } from "./errors.js";
import type {
  AuthenticationAssurance,
  AuthenticationAssurancePolicy,
  ProviderAuthenticationAssurance,
} from "./types.js";

export const unauthenticatedAssurance: AuthenticationAssurance = {
  level: "single_factor",
  methods: [],
  acr: null,
  authenticatedAt: null,
  mfaPerformed: false,
  phishingResistant: false,
};

function invalidEvidence(): never {
  throw new IdentityError("AUTHENTICATION_FAILED", "Authentication assurance evidence is invalid.");
}

export function authenticationAssuranceFromProvider(
  evidence: ProviderAuthenticationAssurance | undefined,
): AuthenticationAssurance {
  if (!evidence) return { ...unauthenticatedAssurance, methods: [] };
  if (evidence.methods.length > 16) invalidEvidence();

  const methods = evidence.methods.map((method) => {
    if (
      typeof method !== "string" ||
      method.length < 1 ||
      method.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(method)
    ) {
      invalidEvidence();
    }
    return method;
  });
  const normalizedMethods = [...new Set(methods)];

  if (
    evidence.acr !== null &&
    (typeof evidence.acr !== "string" || evidence.acr.length > 512 || /[\u0000-\u001f\u007f]/.test(evidence.acr))
  ) {
    invalidEvidence();
  }
  if (evidence.authenticatedAt !== null && !Number.isFinite(evidence.authenticatedAt.getTime())) {
    invalidEvidence();
  }

  const mfaPerformed = normalizedMethods.includes("mfa");
  if (evidence.phishingResistant && !mfaPerformed) {
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication assurance evidence is inconsistent.");
  }

  return {
    level: evidence.phishingResistant ? "phishing_resistant" : mfaPerformed ? "multi_factor" : "single_factor",
    methods: normalizedMethods,
    acr: evidence.acr,
    authenticatedAt: evidence.authenticatedAt,
    mfaPerformed,
    phishingResistant: evidence.phishingResistant,
  };
}

export function requireAuthenticationAssurance(
  assurance: AuthenticationAssurance,
  policy: AuthenticationAssurancePolicy,
  now: Date,
): void {
  if (policy.minimum === "off") return;

  const meetsMinimum = policy.minimum === "mfa" ? assurance.mfaPerformed : assurance.phishingResistant;
  if (!meetsMinimum) {
    throw new IdentityError("AUTHENTICATION_ASSURANCE_REQUIRED", "Stronger authentication is required.");
  }

  if (policy.maxAuthenticationAgeMs !== undefined) {
    if (!assurance.authenticatedAt) {
      throw new IdentityError("AUTHENTICATION_ASSURANCE_REQUIRED", "Recent authentication is required.");
    }
    const ageMs = now.getTime() - assurance.authenticatedAt.getTime();
    if (ageMs < 0 || ageMs > policy.maxAuthenticationAgeMs) {
      throw new IdentityError("AUTHENTICATION_ASSURANCE_REQUIRED", "Recent authentication is required.");
    }
  }
}
