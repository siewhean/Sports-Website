export const accountUiMachine = {
  idle: "idle",
  deleting: "deleting",
  deleted: "deleted",
} as const;

export type AccountDeletionState = (typeof accountUiMachine)[keyof typeof accountUiMachine];

export const accountHttp = {
  jsonUtf8ContentType: "application/json; charset=utf-8",
  sessionCookieNames: ["__Host-matchday_session", "matchday_session"],
} as const;
