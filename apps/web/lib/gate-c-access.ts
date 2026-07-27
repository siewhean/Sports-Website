export type AccessPassRole = "viewer" | "scorekeeper";

export const gateCAccessPermissions = {
  viewer: ["score:read"],
  scorekeeper: ["score:read", "score:write", "score:reverse", "score:finalise"],
} as const;

export const gateCAccessMachine = {
  approve: "approve",
  approved: "approved",
  active: "active",
  anchor: "a",
  contentType: "application/json",
  delete: "DELETE",
  deny: "deny",
  denied: "denied",
  dialog: "dialog",
  errorCode: "ACCESS_INPUT_INVALID",
  expired: "expired",
  noStore: "no-store",
  none: "none",
  pending: "pending",
  post: "POST",
  present: "present",
  qrCorrectionLevel: "M",
  revoked: "revoked",
  sameOrigin: "same-origin",
  scorekeeper: "scorekeeper",
  takeoverDecisionInvalid: "TAKEOVER_DECISION_INVALID",
  takeoverListUnavailable: "TAKEOVER_LIST_UNAVAILABLE",
  takeoverReasonInvalid: "TAKEOVER_REASON_INVALID",
  takeoverResponseInvalid: "TAKEOVER_RESPONSE_INVALID",
  unknown: "unknown",
  viewer: "viewer",
} as const;

export type TakeoverRequestSummary = {
  id: string;
  matchId: string;
  status: "pending" | "approved" | "denied";
  requesterPendingEventCount: number;
  incumbentPendingState: "unknown" | "none" | "present";
  requestedAt: string;
  requestingDeviceLabel: string | null;
  incumbentDeviceLabel: string | null;
};

export type AccessPassSummary = {
  id: string;
  matchId: string;
  role: AccessPassRole;
  permissions: string[];
  expiresAt: string;
  revoked: boolean;
};

export type IssuedAccessPass = AccessPassSummary & {
  token: string | null;
  shortCode: string | null;
  qrPath: string | null;
  duplicate: boolean;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function permissions(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= 16 &&
    value.every((permission) => typeof permission === "string" && /^[a-z]+:[a-z_]+$/.test(permission))
    ? value
    : null;
}

export function parseAccessPassSummary(value: unknown): AccessPassSummary | null {
  const source = record(value);
  const scope = permissions(source?.permissions);
  if (
    !source ||
    !uuid(source.id) ||
    !uuid(source.match_id) ||
    (source.role !== "viewer" && source.role !== "scorekeeper") ||
    !scope ||
    typeof source.expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.expires_at)) ||
    typeof source.revoked !== "boolean"
  ) {
    return null;
  }
  return {
    id: source.id,
    matchId: source.match_id,
    role: source.role,
    permissions: scope,
    expiresAt: source.expires_at,
    revoked: source.revoked,
  };
}

export function parseIssuedAccessPass(value: unknown): IssuedAccessPass | null {
  const summary = parseAccessPassSummary(value);
  const source = record(value);
  if (
    !summary ||
    !source ||
    (source.token !== null &&
      (typeof source.token !== "string" || source.token.length < 32 || source.token.length > 256)) ||
    (source.short_code !== null && (typeof source.short_code !== "string" || !/^\d{12}$/.test(source.short_code))) ||
    (source.qr_path !== null && (typeof source.qr_path !== "string" || !source.qr_path.startsWith("/score#access="))) ||
    typeof source.duplicate !== "boolean"
  ) {
    return null;
  }
  if (!source.duplicate && (!source.token || !source.short_code || !source.qr_path)) return null;
  return {
    ...summary,
    token: source.token as string | null,
    shortCode: source.short_code as string | null,
    qrPath: source.qr_path as string | null,
    duplicate: source.duplicate,
  };
}

export function parseRotatedFallback(
  value: unknown,
): { id: string; shortCode: string | null; duplicate: boolean } | null {
  const source = record(value);
  if (
    !source ||
    !uuid(source.id) ||
    (source.short_code !== null && (typeof source.short_code !== "string" || !/^\d{12}$/.test(source.short_code))) ||
    typeof source.duplicate !== "boolean" ||
    (!source.duplicate && !source.short_code)
  ) {
    return null;
  }
  return { id: source.id, shortCode: source.short_code as string | null, duplicate: source.duplicate };
}

export function parseRevokedPass(value: unknown): { id: string; revoked: true } | null {
  const source = record(value);
  return source && uuid(source.id) && source.revoked === true ? { id: source.id, revoked: true } : null;
}

export function parseTakeoverRequest(value: unknown): TakeoverRequestSummary | null {
  const source = record(value);
  if (
    !source ||
    !uuid(source.id) ||
    !uuid(source.match_id) ||
    (source.status !== "pending" && source.status !== "approved" && source.status !== "denied") ||
    !Number.isSafeInteger(source.requester_pending_event_count) ||
    Number(source.requester_pending_event_count) < 0 ||
    (source.incumbent_pending_state !== "unknown" &&
      source.incumbent_pending_state !== "none" &&
      source.incumbent_pending_state !== "present") ||
    typeof source.requested_at !== "string" ||
    !Number.isFinite(Date.parse(source.requested_at)) ||
    (source.requesting_device_label !== null && typeof source.requesting_device_label !== "string") ||
    (source.incumbent_device_label !== null && typeof source.incumbent_device_label !== "string")
  ) {
    return null;
  }
  return {
    id: source.id,
    matchId: source.match_id,
    status: source.status,
    requesterPendingEventCount: Number(source.requester_pending_event_count),
    incumbentPendingState: source.incumbent_pending_state,
    requestedAt: source.requested_at,
    requestingDeviceLabel: source.requesting_device_label as string | null,
    incumbentDeviceLabel: source.incumbent_device_label as string | null,
  };
}

export function parseTakeoverRequests(value: unknown): TakeoverRequestSummary[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const requests = value.map(parseTakeoverRequest);
  return requests.every((request): request is TakeoverRequestSummary => request !== null) ? requests : null;
}

export type TakeoverDecisionResult =
  | { id: string; status: "denied" }
  | {
      id: string;
      status: "approved";
      generation: number;
      leaseExpiresAt: string;
      conflictId: string | null;
    };

export function parseTakeoverDecision(value: unknown): TakeoverDecisionResult | null {
  const source = record(value);
  if (!source || !uuid(source.id)) return null;
  if (source.status === "denied") return { id: source.id, status: "denied" };
  if (
    source.status !== "approved" ||
    !Number.isSafeInteger(source.generation) ||
    Number(source.generation) < 1 ||
    typeof source.lease_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.lease_expires_at)) ||
    (source.conflict_id !== null && !uuid(source.conflict_id))
  ) {
    return null;
  }
  return {
    id: source.id,
    status: "approved",
    generation: Number(source.generation),
    leaseExpiresAt: source.lease_expires_at,
    conflictId: source.conflict_id as string | null,
  };
}
