import { assertWorkloadBudget, type WorkloadSummary } from "./workload.js";

export const C5_WORKLOAD_OPERATIONS = [
  "score_event_acknowledgement",
  "public_result_convergence",
  "public_current_conditional_read",
  "lease_takeover",
  "repair_publication",
] as const;

export type C5WorkloadOperation = (typeof C5_WORKLOAD_OPERATIONS)[number];

export type C5PilotApproval = Readonly<{
  owner: string;
  approvedAtUtc: string;
  reference: string;
}>;

export type C5WorkloadProfile = Readonly<{
  profileId: string;
  durationSeconds: number;
  scorekeeperCount: number;
  publicReaderCount: number;
  organiserWorkerCount: number;
  approval: C5PilotApproval;
}>;

export type C5WorkloadBudget = Readonly<{
  operation: C5WorkloadOperation;
  maxP95Ms: number;
  maxUnexpectedErrorRate: number;
}>;

const PROFILE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const APPROVAL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_WORKERS_PER_ROLE = 10_000;

export const C5_WORKLOAD_BUDGETS: Readonly<Record<C5WorkloadOperation, C5WorkloadBudget>> = {
  score_event_acknowledgement: {
    operation: "score_event_acknowledgement",
    maxP95Ms: 500,
    maxUnexpectedErrorRate: 0,
  },
  public_result_convergence: {
    operation: "public_result_convergence",
    maxP95Ms: 2_000,
    maxUnexpectedErrorRate: 0,
  },
  public_current_conditional_read: {
    operation: "public_current_conditional_read",
    maxP95Ms: 500,
    maxUnexpectedErrorRate: 0,
  },
  lease_takeover: {
    operation: "lease_takeover",
    maxP95Ms: 2_000,
    maxUnexpectedErrorRate: 0,
  },
  repair_publication: {
    operation: "repair_publication",
    maxP95Ms: 2_000,
    maxUnexpectedErrorRate: 0,
  },
};

function assertFiniteInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
}

/**
 * Rejects an undeclared or unauthorised traffic profile before a C5 harness can
 * generate load. The profile contains no endpoint, tenant, credential, or raw
 * test-principal material, so it is safe to retain with a C5 evidence receipt.
 */
export function assertC5WorkloadProfile(profile: C5WorkloadProfile): void {
  if (!PROFILE_ID.test(profile.profileId)) throw new Error("C5 profileId is invalid");
  assertFiniteInteger(profile.durationSeconds, "C5 durationSeconds", 1, 86_400);
  assertFiniteInteger(profile.scorekeeperCount, "C5 scorekeeperCount", 1, MAX_WORKERS_PER_ROLE);
  assertFiniteInteger(profile.publicReaderCount, "C5 publicReaderCount", 1, MAX_WORKERS_PER_ROLE);
  assertFiniteInteger(profile.organiserWorkerCount, "C5 organiserWorkerCount", 1, MAX_WORKERS_PER_ROLE);
  if (profile.approval.owner.trim().length < 2 || profile.approval.owner.length > 120) {
    throw new Error("C5 approval owner is invalid");
  }
  if (!ISO_UTC.test(profile.approval.approvedAtUtc) || Number.isNaN(Date.parse(profile.approval.approvedAtUtc))) {
    throw new Error("C5 approval timestamp must be an ISO UTC timestamp");
  }
  if (!APPROVAL_REFERENCE.test(profile.approval.reference)) throw new Error("C5 approval reference is invalid");
}

export function assertC5OperationBudget(operation: C5WorkloadOperation, summary: WorkloadSummary): void {
  const budget = C5_WORKLOAD_BUDGETS[operation];
  assertWorkloadBudget(summary, budget);
}
