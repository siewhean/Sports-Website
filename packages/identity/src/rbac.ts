import { AuthorizationError } from "./errors.js";
import type { MembershipRole, MembershipStatus } from "./membership.js";

export const permissions = [
  "organisation.read",
  "organisation.update",
  "membership.manage",
  "competition.create",
  "competition.read",
  "competition.update",
  "competition.delete",
  "competition.publish",
  "match.read",
  "match.score",
  "match.finalise",
  "match.correct",
  "audit.read",
  "platform.read",
  "platform.support",
] as const;
export type Permission = (typeof permissions)[number];

export type ResourceScope =
  | { kind: "platform" }
  | { kind: "organisation"; id: string; organisationId: string }
  | {
      kind: "competition";
      id: string;
      organisationId: string;
      isPublished: boolean;
    }
  | {
      kind: "match";
      id: string;
      organisationId: string;
      competitionId: string;
      isPublished: boolean;
    };

export type PrincipalMembership = {
  organisationId: string;
  role: MembershipRole;
  status: MembershipStatus;
};

export type OfficialGrant = {
  kind: "competition" | "match";
  resourceId: string;
  organisationId: string;
  status: "active" | "revoked";
};

export type Principal = {
  accountId: string | null;
  platformRoles: readonly "platform_admin"[];
  memberships: readonly PrincipalMembership[];
  officialGrants: readonly OfficialGrant[];
};

export const publicPrincipal: Principal = {
  accountId: null,
  platformRoles: [],
  memberships: [],
  officialGrants: [],
};

export type AuthorizationDecision =
  | { allowed: true; reason: "platform_admin" | "organisation_role" | "official_grant" | "public_projection" }
  | {
      allowed: false;
      reason:
        | "authentication_required"
        | "cross_organisation"
        | "inactive_membership"
        | "insufficient_role"
        | "missing_official_grant"
        | "private_projection";
    };

const organiserPermissions: ReadonlySet<Permission> = new Set([
  "organisation.read",
  "organisation.update",
  "competition.create",
  "competition.read",
  "competition.update",
  "competition.delete",
  "competition.publish",
  "match.read",
  "match.score",
  "match.finalise",
  "match.correct",
  "audit.read",
]);

const viewerPermissions: ReadonlySet<Permission> = new Set(["organisation.read", "competition.read", "match.read"]);

function isPublishedRead(permission: Permission, resource: ResourceScope): boolean {
  if (resource.kind !== "competition" && resource.kind !== "match") return false;
  return resource.isPublished && (permission === "competition.read" || permission === "match.read");
}

function organisationId(resource: ResourceScope): string | null {
  return resource.kind === "platform" ? null : resource.organisationId;
}

export function authorize(
  principal: Principal,
  permission: Permission,
  resource: ResourceScope,
): AuthorizationDecision {
  if (principal.platformRoles.includes("platform_admin")) {
    return { allowed: true, reason: "platform_admin" };
  }

  if (isPublishedRead(permission, resource)) {
    return { allowed: true, reason: "public_projection" };
  }

  if (!principal.accountId) {
    return {
      allowed: false,
      reason:
        resource.kind === "competition" || resource.kind === "match" ? "private_projection" : "authentication_required",
    };
  }

  const resourceOrganisationId = organisationId(resource);
  if (!resourceOrganisationId) return { allowed: false, reason: "insufficient_role" };

  const membership = principal.memberships.find((candidate) => candidate.organisationId === resourceOrganisationId);
  if (membership) {
    if (membership.status !== "active") return { allowed: false, reason: "inactive_membership" };
    if (membership.role === "owner") {
      if (permission === "platform.read" || permission === "platform.support") {
        return { allowed: false, reason: "insufficient_role" };
      }
      return { allowed: true, reason: "organisation_role" };
    }
    if (membership.role === "organiser" && organiserPermissions.has(permission)) {
      return { allowed: true, reason: "organisation_role" };
    }
    if (membership.role === "viewer" && viewerPermissions.has(permission)) {
      return { allowed: true, reason: "organisation_role" };
    }
  }

  if (resource.kind === "competition" || resource.kind === "match") {
    const hasOfficialGrant = principal.officialGrants.some(
      (grant) =>
        grant.status === "active" &&
        grant.organisationId === resource.organisationId &&
        ((grant.kind === "competition" &&
          grant.resourceId === (resource.kind === "match" ? resource.competitionId : resource.id)) ||
          (grant.kind === "match" && resource.kind === "match" && grant.resourceId === resource.id)),
    );
    if (hasOfficialGrant && ["competition.read", "match.read", "match.score", "match.finalise"].includes(permission)) {
      return { allowed: true, reason: "official_grant" };
    }
    if (principal.officialGrants.length > 0) return { allowed: false, reason: "missing_official_grant" };
  }

  if (principal.memberships.some((candidate) => candidate.status === "active")) {
    return { allowed: false, reason: membership ? "insufficient_role" : "cross_organisation" };
  }
  return { allowed: false, reason: membership ? "inactive_membership" : "insufficient_role" };
}

export function requirePermission(principal: Principal, permission: Permission, resource: ResourceScope): void {
  const decision = authorize(principal, permission, resource);
  if (!decision.allowed) throw new AuthorizationError(decision.reason);
}
