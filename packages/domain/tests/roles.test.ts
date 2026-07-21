import { describe, expect, it } from "vitest";
import { hasRole, isRole, type Identity } from "../src/index.js";

describe("roles", () => {
  const identity: Identity = {
    accountId: "account-1",
    organisationId: "organisation-1",
    roles: ["organiser"],
  };

  it("recognises only declared roles", () => {
    expect(isRole("organiser")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });

  it("checks role membership without implicit elevation", () => {
    expect(hasRole(identity, "organiser")).toBe(true);
    expect(hasRole(identity, "platform_admin")).toBe(false);
  });
});
