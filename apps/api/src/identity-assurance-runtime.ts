import {
  IdentityError,
  requireAuthenticationAssurance,
  type AuthenticationAssurance,
  type AuthenticationAssurancePolicy,
  type Clock,
  type IdentityProviderPort,
} from "@matchday/identity";
import { ApiError } from "./errors.js";
import {
  IdentityApiRuntime,
  type AuthenticatedIdentityApiSession,
  type IdentityPersistenceUnitOfWork,
} from "./identity-runtime.js";

export type AssuranceAwareSession = AuthenticatedIdentityApiSession & {
  assurance: AuthenticationAssurance;
};

export class IdentityAssuranceRuntime extends IdentityApiRuntime {
  constructor(
    provider: IdentityProviderPort,
    unitOfWork: IdentityPersistenceUnitOfWork,
    csrfSecret: string,
    private readonly assuranceClock: Clock,
    private readonly policy: AuthenticationAssurancePolicy,
  ) {
    super(provider, unitOfWork, csrfSecret, assuranceClock);
  }

  requireConfiguredAssurance(session: AuthenticatedIdentityApiSession): void {
    const assurance = (session as AssuranceAwareSession).assurance;
    if (!assurance) {
      throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
    }
    try {
      requireAuthenticationAssurance(assurance, this.policy, this.assuranceClock.now());
    } catch (error) {
      if (error instanceof IdentityError && error.code === "AUTHENTICATION_ASSURANCE_REQUIRED") {
        throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
      }
      throw error;
    }
  }

  require(session: AuthenticatedIdentityApiSession, policy: AuthenticationAssurancePolicy): void {
    const assurance = (session as AssuranceAwareSession).assurance;
    if (!assurance) {
      throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
    }
    try {
      requireAuthenticationAssurance(assurance, policy, this.assuranceClock.now());
    } catch (error) {
      if (error instanceof IdentityError && error.code === "AUTHENTICATION_ASSURANCE_REQUIRED") {
        throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
      }
      throw error;
    }
  }
}
