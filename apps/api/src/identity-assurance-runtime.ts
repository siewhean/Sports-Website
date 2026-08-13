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
    clock: Clock,
    private readonly policy: AuthenticationAssurancePolicy,
  ) {
    super(provider, unitOfWork, csrfSecret, clock);
  }

  override async authenticate(sessionToken: string, requestId: string): Promise<AssuranceAwareSession> {
    const session = (await super.authenticate(sessionToken, requestId)) as AssuranceAwareSession;
    this.require(session, this.policy);
    return session;
  }

  require(session: AssuranceAwareSession, policy: AuthenticationAssurancePolicy): void {
    try {
      requireAuthenticationAssurance(session.assurance, policy, new Date());
    } catch (error) {
      if (error instanceof IdentityError && error.code === "AUTHENTICATION_ASSURANCE_REQUIRED") {
        throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
      }
      throw error;
    }
  }
}
