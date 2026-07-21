import type { AuditJson } from "./audit.js";

export const membershipRoles = ["owner", "organiser", "viewer"] as const;
export type MembershipRole = (typeof membershipRoles)[number];
export type MembershipStatus = "invited" | "active" | "suspended";

export type Organisation = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganisationMembership = {
  id: string;
  organisationId: string;
  accountId: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
};

export interface OrganisationRepository {
  createWithOwner(input: {
    name: string;
    slug: string;
    ownerAccountId: string;
    createdAt: Date;
  }): Promise<{ organisation: Organisation; membership: OrganisationMembership }>;
  findById(organisationId: string): Promise<Organisation | null>;
  listMemberships(organisationId: string): Promise<readonly OrganisationMembership[]>;
  findMembership(organisationId: string, accountId: string): Promise<OrganisationMembership | null>;
  upsertMembership(input: {
    organisationId: string;
    accountId: string;
    role: MembershipRole;
    status: MembershipStatus;
    updatedAt: Date;
  }): Promise<OrganisationMembership>;
}

export interface MembershipAuditPort {
  record(input: {
    requestId: string;
    actorAccountId: string;
    organisationId: string;
    action: "organisation.created" | "membership.changed";
    targetId: string;
    beforeState: AuditJson;
    afterState: AuditJson;
    occurredAt: Date;
  }): Promise<void>;
}

export interface OrganisationUnitOfWork {
  run<T>(
    operation: (ports: { organisations: OrganisationRepository; audit: MembershipAuditPort }) => Promise<T>,
  ): Promise<T>;
}

function normalizedOrganisationName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (value.length < 2 || value.length > 120) throw new Error("Organisation name is invalid.");
  return value;
}

function normalizedSlug(slug: string): string {
  const value = slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("Organisation slug is invalid.");
  }
  return value;
}

export class OrganisationService {
  constructor(
    private readonly unitOfWork: OrganisationUnitOfWork,
    private readonly now: () => Date,
  ) {}

  async create(input: { requestId: string; name: string; slug: string; ownerAccountId: string }) {
    const createdAt = this.now();
    return this.unitOfWork.run(async ({ organisations, audit }) => {
      const created = await organisations.createWithOwner({
        name: normalizedOrganisationName(input.name),
        slug: normalizedSlug(input.slug),
        ownerAccountId: input.ownerAccountId,
        createdAt,
      });
      await audit.record({
        requestId: input.requestId,
        actorAccountId: input.ownerAccountId,
        organisationId: created.organisation.id,
        action: "organisation.created",
        targetId: created.organisation.id,
        beforeState: null,
        afterState: { name: created.organisation.name, slug: created.organisation.slug },
        occurredAt: createdAt,
      });
      return created;
    });
  }

  async changeMembership(input: {
    requestId: string;
    actorAccountId: string;
    organisationId: string;
    accountId: string;
    role: MembershipRole;
    status: MembershipStatus;
  }) {
    const updatedAt = this.now();
    return this.unitOfWork.run(async ({ organisations, audit }) => {
      const actor = await organisations.findMembership(input.organisationId, input.actorAccountId);
      if (!actor || actor.status !== "active" || actor.role !== "owner") {
        throw new Error("Only an active organisation owner can manage memberships.");
      }
      const before = await organisations.findMembership(input.organisationId, input.accountId);
      if (before?.role === "owner" && (input.role !== "owner" || input.status !== "active")) {
        const activeOwners = (await organisations.listMemberships(input.organisationId)).filter(
          (membership) => membership.role === "owner" && membership.status === "active",
        );
        if (activeOwners.length <= 1) throw new Error("An organisation must retain an active owner.");
      }
      const membership = await organisations.upsertMembership({
        organisationId: input.organisationId,
        accountId: input.accountId,
        role: input.role,
        status: input.status,
        updatedAt,
      });
      await audit.record({
        requestId: input.requestId,
        actorAccountId: input.actorAccountId,
        organisationId: input.organisationId,
        action: "membership.changed",
        targetId: membership.id,
        beforeState: before ? { role: before.role, status: before.status } : null,
        afterState: { role: membership.role, status: membership.status },
        occurredAt: updatedAt,
      });
      return membership;
    });
  }
}
