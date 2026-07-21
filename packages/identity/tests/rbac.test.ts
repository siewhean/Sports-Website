import { describe, expect, it } from "vitest";
import { authorize, publicPrincipal, requirePermission, type Principal } from "../src/rbac.js";

const competition = {
  kind: "competition" as const,
  id: "competition-1",
  organisationId: "organisation-1",
  isPublished: false,
};
const match = {
  kind: "match" as const,
  id: "match-1",
  organisationId: "organisation-1",
  competitionId: "competition-1",
  isPublished: false,
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return { accountId: "account-1", platformRoles: [], memberships: [], officialGrants: [], ...overrides };
}

describe("object-scoped RBAC", () => {
  it("allows only published projections to anonymous users", () => {
    expect(authorize(publicPrincipal, "competition.read", { ...competition, isPublished: true }).allowed).toBe(true);
    expect(authorize(publicPrincipal, "competition.read", competition)).toEqual({
      allowed: false,
      reason: "private_projection",
    });
    expect(authorize(publicPrincipal, "match.score", { ...match, isPublished: true }).allowed).toBe(false);
  });

  it("grants active organisers operational permissions but not membership management", () => {
    const organiser = principal({
      memberships: [{ organisationId: "organisation-1", role: "organiser", status: "active" }],
    });
    expect(authorize(organiser, "competition.publish", competition).allowed).toBe(true);
    expect(authorize(organiser, "audit.read", competition).allowed).toBe(true);
    expect(authorize(organiser, "membership.manage", competition)).toEqual({
      allowed: false,
      reason: "insufficient_role",
    });
  });

  it("denies suspended and cross-organisation memberships", () => {
    const suspended = principal({
      memberships: [{ organisationId: "organisation-1", role: "owner", status: "suspended" }],
    });
    expect(authorize(suspended, "competition.update", competition).reason).toBe("inactive_membership");
    const other = principal({
      memberships: [{ organisationId: "organisation-2", role: "owner", status: "active" }],
    });
    expect(authorize(other, "competition.update", competition).reason).toBe("cross_organisation");
  });

  it("scopes officials to an explicit match or competition grant", () => {
    const official = principal({
      officialGrants: [
        { kind: "competition", resourceId: "competition-1", organisationId: "organisation-1", status: "active" },
      ],
    });
    expect(authorize(official, "match.score", match)).toEqual({ allowed: true, reason: "official_grant" });
    expect(authorize(official, "match.correct", match).allowed).toBe(false);
    expect(authorize(official, "match.score", { ...match, id: "match-2", competitionId: "competition-2" }).reason).toBe(
      "missing_official_grant",
    );
  });

  it("allows platform administrators and throws a non-disclosing authorization error otherwise", () => {
    const administrator = principal({ platformRoles: ["platform_admin"] });
    expect(authorize(administrator, "platform.support", { kind: "platform" }).allowed).toBe(true);
    expect(() => requirePermission(publicPrincipal, "platform.support", { kind: "platform" })).toThrow(
      "You do not have permission",
    );
  });
});
