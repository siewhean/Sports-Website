import type { FastifyRequest } from "fastify";
import { IdentityAssuranceRuntime } from "./identity-assurance-runtime.js";
import { IdentityRequestContext } from "./identity-routes.js";
import type { AuthenticatedIdentityApiSession } from "./identity-runtime.js";

const RAW_SESSION_ROUTES = new Set(["/api/v1/identity/sign-out"]);

function requestRoute(request: FastifyRequest): string {
  return request.routeOptions.url || request.url.split("?", 1)[0] || "";
}

/**
 * Keeps opaque-session validation available for self-revocation and trusted
 * rate-limit attribution, while requiring configured authentication assurance
 * everywhere existing organiser routes ask for an authenticated identity.
 */
export class IdentityAssuranceRequestContext extends IdentityRequestContext {
  constructor(
    private readonly assuranceRuntime: IdentityAssuranceRuntime,
    cookieName: string,
  ) {
    super(assuranceRuntime, cookieName);
  }

  override async authenticate(request: FastifyRequest): Promise<AuthenticatedIdentityApiSession> {
    const session = await super.authenticate(request);
    if (!RAW_SESSION_ROUTES.has(requestRoute(request))) {
      this.assuranceRuntime.requireConfiguredAssurance(session);
    }
    return session;
  }

  override async rateLimitAccountId(request: FastifyRequest): Promise<string | null> {
    try {
      return (await super.authenticate(request)).account.id;
    } catch {
      return null;
    }
  }
}
