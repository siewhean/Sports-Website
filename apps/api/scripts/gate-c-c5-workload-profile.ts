import { assertC5WorkloadProfile, type C5WorkloadProfile } from "@matchday/observability";

const PROFILE_KEYS = [
  "profileId",
  "durationSeconds",
  "scorekeeperCount",
  "publicReaderCount",
  "organiserWorkerCount",
  "approval",
] as const;
const APPROVAL_KEYS = ["owner", "approvedAtUtc", "reference"] as const;
const secretLikeApprovalValue =
  /(?:\b(?:secret|token|password|cookie|authorization|bearer)\b|(?:redis|postgres(?:ql)?):\/\/|https?:\/\/)/iu;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  return observed.length === keys.length && observed.every((key, index) => key === [...keys].sort()[index]);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw new Error(`Gate C C5 workload profile ${key} must be a string`);
  return candidate;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw new Error(`Gate C C5 workload profile ${key} must be an integer`);
  }
  return candidate;
}

function requiredApprovalText(value: Record<string, unknown>, key: string): string {
  const candidate = requiredString(value, key);
  if (secretLikeApprovalValue.test(candidate)) {
    throw new Error(`Gate C C5 workload profile ${key} must not contain secret-like content`);
  }
  return candidate;
}

/** Parses the deliberately non-secret approved workload profile supplied to a C5 run. */
export function parseGateCC5WorkloadProfile(value: string | undefined): C5WorkloadProfile {
  if (!value?.trim()) throw new Error("Gate C C5 workload run requires GATE_C_C5_WORKLOAD_PROFILE_JSON");
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("Gate C C5 workload profile is not valid JSON");
  }
  const candidate = record(payload);
  const approval = candidate ? record(candidate.approval) : null;
  if (!candidate || !approval || !exactKeys(candidate, PROFILE_KEYS) || !exactKeys(approval, APPROVAL_KEYS)) {
    throw new Error("Gate C C5 workload profile has an unsupported field");
  }
  const profile: C5WorkloadProfile = {
    profileId: requiredString(candidate, "profileId"),
    durationSeconds: requiredInteger(candidate, "durationSeconds"),
    scorekeeperCount: requiredInteger(candidate, "scorekeeperCount"),
    publicReaderCount: requiredInteger(candidate, "publicReaderCount"),
    organiserWorkerCount: requiredInteger(candidate, "organiserWorkerCount"),
    approval: {
      owner: requiredApprovalText(approval, "owner"),
      approvedAtUtc: requiredString(approval, "approvedAtUtc"),
      reference: requiredApprovalText(approval, "reference"),
    },
  };
  assertC5WorkloadProfile(profile);
  return profile;
}

export function parseGateCC5MaximumSamples(value: string | undefined): number {
  if (!value?.trim()) return 100;
  if (!/^\d+$/u.test(value)) throw new Error("Gate C C5 maximum samples must be an integer");
  const maximumSamples = Number(value);
  if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 1 || maximumSamples > 1_000_000) {
    throw new Error("Gate C C5 maximum samples must be from 1 to 1000000");
  }
  return maximumSamples;
}
