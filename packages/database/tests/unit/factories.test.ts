import { describe, expect, it } from "vitest";
import { accountFactory, membershipFactory, organisationFactory } from "../../src/factories.js";

describe("test-data factories", () => {
  it("are stable for a given index and unique across indexes", () => {
    expect(accountFactory(1)).toEqual(accountFactory(1));
    expect(accountFactory(1).id).not.toBe(accountFactory(2).id);
    expect(organisationFactory(1).slug).toBe("test-organisation-1");
  });

  it("links the canonical owner membership", () => {
    const membership = membershipFactory(3);
    expect(membership.accountId).toBe(accountFactory(3).id);
    expect(membership.organisationId).toBe(organisationFactory(3).id);
    expect(membership.role).toBe("owner");
  });
});
