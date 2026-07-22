import "server-only";

const deployedEnvironments = new Set(["staging", "production"]);

export function assertSafeDeploymentDataMode(environment: NodeJS.ProcessEnv = process.env): void {
  const appEnvironment = environment.APP_ENV?.trim() || "local";
  if (!new Set(["local", "test", "staging", "production"]).has(appEnvironment)) {
    throw new Error("APP_ENV must be local, test, staging, or production");
  }

  const dataMode = environment.MATCHDAY_PHASE2_DATA_MODE?.trim() || "api";
  if (dataMode !== "api" && dataMode !== "demo") {
    throw new Error("MATCHDAY_PHASE2_DATA_MODE must be api or demo");
  }

  if (!deployedEnvironments.has(appEnvironment)) return;
  if (dataMode === "demo") {
    throw new Error("MATCHDAY_PHASE2_DATA_MODE=demo is forbidden in staging and production");
  }

  const rawApiOrigin = environment.MATCHDAY_API_BASE_URL?.trim();
  if (!rawApiOrigin) throw new Error("MATCHDAY_API_BASE_URL must be configured in staging and production");
  let apiOrigin: URL;
  try {
    apiOrigin = new URL(rawApiOrigin);
  } catch {
    throw new Error("MATCHDAY_API_BASE_URL must be a valid absolute URL");
  }
  if (apiOrigin.protocol !== "https:") {
    throw new Error("MATCHDAY_API_BASE_URL must use HTTPS in staging and production");
  }
  if (apiOrigin.username || apiOrigin.password || apiOrigin.hash || apiOrigin.search) {
    throw new Error("MATCHDAY_API_BASE_URL must be an origin without credentials, query, or fragment");
  }
  if (apiOrigin.pathname !== "/") {
    throw new Error("MATCHDAY_API_BASE_URL must not include a path");
  }
}
