import { describe, expect, it } from "vitest";
import { OrganisationService } from "../src/membership.js";
import { InMemoryOrganisationUnitOfWork } from "../src/testing.js";

describe("OrganisationService", () => {
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const setup = () => {
    const unitOfWork = new InMemoryOrganisationUnitOfWork();
    return { unitOfWork, service: new OrganisationService(unitOfWork, now) };
  };

  it("creates an organisation with one active owner and audit evidence", async () => {
    const { service, unitOfWork } = setup();
    const created = await service.create({
      requestId: "request-1",
      name: "  Singapore   Canoe Polo  ",
      slug: "Singapore-Canoe-Polo",
      ownerAccountId: "account-1",
    });
    expect(created.organisation).toMatchObject({ name: "Singapore Canoe Polo", slug: "singapore-canoe-polo" });
    expect(created.membership).toMatchObject({ role: "owner", status: "active", accountId: "account-1" });
    expect(unitOfWork.audit.records).toHaveLength(1);
  });

  it("allows owners to add future team members and audits the change", async () => {
    const { service, unitOfWork } = setup();
    const created = await service.create({
      requestId: "request-1",
      name: "Canoe Polo",
      slug: "canoe-polo",
      ownerAccountId: "account-1",
    });
    const membership = await service.changeMembership({
      requestId: "request-2",
      actorAccountId: "account-1",
      organisationId: created.organisation.id,
      accountId: "account-2",
      role: "organiser",
      status: "invited",
    });
    expect(membership).toMatchObject({ accountId: "account-2", role: "organiser", status: "invited" });
    expect(unitOfWork.audit.records.at(-1)).toMatchObject({ action: "membership.changed", requestId: "request-2" });
  });

  it("denies membership management to non-owners", async () => {
    const { service } = setup();
    const created = await service.create({
      requestId: "request-1",
      name: "Canoe Polo",
      slug: "canoe-polo",
      ownerAccountId: "account-1",
    });
    await expect(
      service.changeMembership({
        requestId: "request-2",
        actorAccountId: "account-2",
        organisationId: created.organisation.id,
        accountId: "account-3",
        role: "viewer",
        status: "active",
      }),
    ).rejects.toThrow("Only an active organisation owner");
  });

  it("prevents suspending the only active owner", async () => {
    const { service } = setup();
    const created = await service.create({
      requestId: "request-1",
      name: "Canoe Polo",
      slug: "canoe-polo",
      ownerAccountId: "account-1",
    });
    await expect(
      service.changeMembership({
        requestId: "request-2",
        actorAccountId: "account-1",
        organisationId: created.organisation.id,
        accountId: "account-1",
        role: "owner",
        status: "suspended",
      }),
    ).rejects.toThrow("retain an active owner");
  });

  it("prevents demoting the only active owner", async () => {
    const { service } = setup();
    const created = await service.create({
      requestId: "request-1",
      name: "Canoe Polo",
      slug: "canoe-polo",
      ownerAccountId: "account-1",
    });
    await expect(
      service.changeMembership({
        requestId: "request-2",
        actorAccountId: "account-1",
        organisationId: created.organisation.id,
        accountId: "account-1",
        role: "viewer",
        status: "active",
      }),
    ).rejects.toThrow("retain an active owner");
  });
});
