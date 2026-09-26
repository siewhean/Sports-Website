export const identityStatusRequest = {
  cache: "no-store",
  credentials: "same-origin",
} as const;

export const identityStatusResponseHeaders = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
} as const;

export const identityStatusValues = {
  authenticated: "authenticated",
  stepUpRequired: "step_up_required",
  unauthenticated: "unauthenticated",
} as const;
