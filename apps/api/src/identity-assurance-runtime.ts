import {
  IdentityError,
  requireAuthenticationAssurance,
  type AuthenticationAssurance,
  type AuthenticationAssurancePolicy,
} from "@matchday/identity";
import { ApiError } from "./errors.js";
import { IdentityApiRuntime, type AuthenticatedIdentityApiSession } from "./identity-runtime.js";

export type AssuranceAwareSession = AuthenticatedIdentityApiSession & {
  assurance: AuthenticationAssurance;
};

export class IdentityAssuranceRuntime {
  constructor(
    private readonly identity: IdentityApiRuntime,
    private readonly policy: AuthenticationAssurancePolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authenticate(sessionToken: string, requestId: string): Promise<AssuranceAwareSession> {
    const session = (await this.identity.authenticate(sessionToken, requestId)) as AssuranceAwareSession;
    this.require(session, this.policy);
    return session;
  }

  require(session: AssuranceAwareSession, policy: AuthenticationAssurancePolicy): void {
    try {
      requireAuthenticationAssurance(session.assurance, policy, this.now());
    } catch (error) {
      if (error instanceof IdentityError && error.code === "AUTHENTICATION_ASSURANCE_REQUIRED") {
        throw new ApiError(403, "STEP_UP_REQUIRED", "Stronger authentication is required");
      }
      throw error;
    }
  }
}
