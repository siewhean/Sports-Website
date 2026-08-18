import {
  IdentityError,
  requireAuthenticationAssurance,
  type AuthenticationAssurancePolicy,
  type Clock,
  type IdentityProviderPort,
} from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import {
  IdentityApiRuntime,
  type AuthenticatedIdentityApiSession,
  type IdentityPersistenceUnitOfWork,
} from "./identity-runtime.js";

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
    this.require(session, this.policy);
  }

  require(session: AuthenticatedIdentityApiSession, policy: AuthenticationAssurancePolicy): void {
    if (policy.minimum === "off") return;
    try {
      requireAuthenticationAssurance(session.assurance, policy, this.assuranceClock.now());
    } catch (error) {
      if (error instanceof IdentityError && error.code === "AUTHENTICATION_ASSURANCE_REQUIRED") {
        throw new ApiError(403, ErrorCode.STEP_UP_REQUIRED, "Stronger authentication is required");
      }
      throw error;
    }
  }
}
