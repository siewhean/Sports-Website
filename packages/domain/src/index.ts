export const roles = ["organiser", "official", "public", "platform_admin"] as const;
export type Role = (typeof roles)[number];

export type Identity = {
  accountId: string;
  organisationId: string | null;
  roles: readonly Role[];
};

export function hasRole(identity: Identity, role: Role): boolean {
  return identity.roles.includes(role);
}

export function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export * from "./canoe-polo.js";
export * from "./capacity.js";
export * from "./format.js";
export * from "./format-builder.js";
export * from "./schedule.js";
export * from "./schedule-constraints.js";
export * from "./assisted-setup.js";
export * from "./scoring.js";
export * from "./results.js";
export * from "./publication.js";
export * from "./sport-packs.js";
export * as competitionDomain from "./competition.js";

export * from "./five-sport-scoring.js";
