import { createHash } from "node:crypto";

function deterministicUuid(namespace: string, index: number): string {
  const hash = createHash("sha256").update(`${namespace}:${index}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function accountFactory(index = 1) {
  return {
    id: deterministicUuid("account", index),
    primaryEmail: `organiser-${index}@example.test`,
    displayName: `Organiser ${index}`,
    status: "active" as const,
  };
}

export function organisationFactory(index = 1) {
  return {
    id: deterministicUuid("organisation", index),
    name: `Test Organisation ${index}`,
    slug: `test-organisation-${index}`,
  };
}

export function membershipFactory(index = 1) {
  return {
    id: deterministicUuid("membership", index),
    accountId: accountFactory(index).id,
    organisationId: organisationFactory(index).id,
    role: "owner" as const,
    status: "active" as const,
  };
}
