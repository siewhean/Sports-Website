import { readFile } from "node:fs/promises";
import { generateOpenApiDocument } from "./openapi.js";

const target = new URL("../openapi.generated.json", import.meta.url);
const current = await readFile(target, "utf8");
const generated = await generateOpenApiDocument();
if (current !== generated) throw new Error("OpenAPI artifact is stale. Run `pnpm openapi:generate`.");
const document = JSON.parse(current) as {
  paths?: Record<string, Record<string, { security?: Record<string, unknown>[]; responses?: Record<string, unknown> }>>;
  servers?: { url?: string }[];
  components?: {
    securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>;
  };
};
const requiredPaths = [
  "/api/v1/identity/authorize",
  "/api/v1/identity/callback",
  "/api/v1/identity/recovery",
  "/api/v1/identity/me",
  "/api/v1/identity/sign-out",
  "/api/v1/identity/provider-events",
] as const;
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`OpenAPI artifact is missing required path: ${path}`);
}
if (!document.servers?.some((server) => server.url === "/")) {
  throw new Error("OpenAPI artifact is missing the root server URL.");
}
const sessionCookie = document.components?.securitySchemes?.sessionCookie;
if (!sessionCookie) {
  throw new Error("OpenAPI artifact is missing the sessionCookie security scheme.");
}
const providerEventSignature = document.components?.securitySchemes?.providerEventSignature;
if (
  providerEventSignature?.type !== "apiKey" ||
  providerEventSignature.in !== "header" ||
  providerEventSignature.name !== "x-matchday-provider-signature"
) {
  throw new Error("OpenAPI providerEventSignature scheme does not match the signed back-channel contract.");
}
if (
  sessionCookie.type !== "apiKey" ||
  sessionCookie.in !== "cookie" ||
  sessionCookie.name !== "__Host-matchday_session"
) {
  throw new Error("OpenAPI sessionCookie scheme does not match the production cookie contract.");
}
for (const [path, method] of [
  ["/api/v1/identity/me", "get"],
  ["/api/v1/identity/me", "patch"],
  ["/api/v1/identity/sign-out", "post"],
] as const) {
  const operation = document.paths?.[path]?.[method];
  if (!operation?.security?.some((requirement) => "sessionCookie" in requirement)) {
    throw new Error(`OpenAPI artifact is missing sessionCookie security on ${method.toUpperCase()} ${path}.`);
  }
}
if (document.paths?.["/api/v1/identity/sign-in"]) {
  throw new Error("OpenAPI artifact must not expose the local/test direct identity exchange.");
}
if (!document.paths?.["/api/v1/identity/authorize"]?.get?.responses?.["400"]) {
  throw new Error("OpenAPI artifact is missing redirect rejection on GET /api/v1/identity/authorize.");
}
if (!document.paths?.["/api/v1/identity/callback"]?.get?.responses?.["401"]) {
  throw new Error("OpenAPI artifact is missing authentication rejection on GET /api/v1/identity/callback.");
}
if (!document.paths?.["/api/v1/identity/callback"]?.get?.responses?.["403"]) {
  throw new Error("OpenAPI artifact is missing sign-in policy rejection on GET /api/v1/identity/callback.");
}
if (
  !document.paths?.["/api/v1/identity/provider-events"]?.post?.security?.some(
    (requirement) => "providerEventSignature" in requirement,
  )
) {
  throw new Error("OpenAPI artifact is missing signed security on POST /api/v1/identity/provider-events.");
}
if (!document.paths?.["/api/v1/identity/recovery"]?.get?.responses?.["303"]) {
  throw new Error("OpenAPI artifact is missing hosted recovery redirect.");
}
console.log("OpenAPI artifact is current and valid JSON.");
