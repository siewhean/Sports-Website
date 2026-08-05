import { generateOpenApiDocument } from "./openapi.js";

const generated = await generateOpenApiDocument();
const document = JSON.parse(generated) as {
  paths?: Record<
    string,
    Record<
      string,
      {
        security?: Record<string, unknown>[];
        parameters?: Array<{ name?: string }>;
        requestBody?: { content?: { "application/json"?: { schema?: { additionalProperties?: boolean } } } };
        responses?: Record<string, unknown>;
      }
    >
  >;
  servers?: { url?: string }[];
  components?: {
    securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>;
  };
};

const requiredIdentityPaths = [
  "/api/v1/identity/authorize",
  "/api/v1/identity/callback",
  "/api/v1/identity/recovery",
  "/api/v1/identity/me",
  "/api/v1/identity/sign-out",
  "/api/v1/identity/provider-events",
] as const;
for (const path of requiredIdentityPaths) {
  if (!document.paths?.[path]) throw new Error(`OpenAPI contract is missing required path: ${path}`);
}

if (!document.servers?.some((server) => server.url === "/")) {
  throw new Error("OpenAPI contract is missing the root server URL.");
}
const sessionCookie = document.components?.securitySchemes?.sessionCookie;
if (!sessionCookie) throw new Error("OpenAPI contract is missing the sessionCookie security scheme.");
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
    throw new Error(`OpenAPI contract is missing sessionCookie security on ${method.toUpperCase()} ${path}.`);
  }
}
if (document.paths?.["/api/v1/identity/sign-in"]) {
  throw new Error("OpenAPI contract must not expose the local/test direct identity exchange.");
}
if (!document.paths?.["/api/v1/identity/authorize"]?.get?.responses?.["400"]) {
  throw new Error("OpenAPI contract is missing redirect rejection on GET /api/v1/identity/authorize.");
}
if (!document.paths?.["/api/v1/identity/callback"]?.get?.responses?.["401"]) {
  throw new Error("OpenAPI contract is missing authentication rejection on GET /api/v1/identity/callback.");
}
if (!document.paths?.["/api/v1/identity/callback"]?.get?.responses?.["403"]) {
  throw new Error("OpenAPI contract is missing sign-in policy rejection on GET /api/v1/identity/callback.");
}
if (
  !document.paths?.["/api/v1/identity/provider-events"]?.post?.security?.some(
    (requirement) => "providerEventSignature" in requirement,
  )
) {
  throw new Error("OpenAPI contract is missing signed security on POST /api/v1/identity/provider-events.");
}
if (!document.paths?.["/api/v1/identity/recovery"]?.get?.responses?.["302"]) {
  throw new Error("OpenAPI contract is missing Universal Login recovery redirect.");
}

const setupPath = "/api/v1/competitions/{competitionId}/setup-draft";
const resumePath = "/api/v1/competitions/{competitionId}/setup-draft/resume";
for (const [path, method] of [
  [setupPath, "patch"],
  [resumePath, "post"],
] as const) {
  const operation = document.paths?.[path]?.[method];
  if (!operation) throw new Error(`OpenAPI contract is missing ${method.toUpperCase()} ${path}.`);
  if (!operation.security?.some((requirement) => "sessionCookie" in requirement)) {
    throw new Error(`OpenAPI contract is missing sessionCookie security on ${method.toUpperCase()} ${path}.`);
  }
  const headers = operation.parameters?.map((parameter) => parameter.name) ?? [];
  if (!headers.includes("origin") || !headers.includes("x-csrf-token")) {
    throw new Error(`OpenAPI contract is missing mutation headers on ${method.toUpperCase()} ${path}.`);
  }
  if (operation.requestBody?.content?.["application/json"]?.schema?.additionalProperties !== false) {
    throw new Error(`OpenAPI contract must reject unknown JSON fields on ${method.toUpperCase()} ${path}.`);
  }
  if (!operation.responses?.["409"] || !operation.responses?.["422"]) {
    throw new Error(`OpenAPI contract is missing conflict or validation responses on ${method.toUpperCase()} ${path}.`);
  }
}

const bootstrapPath = "/api/v1/organisations/competition-options/bootstrap";
const bootstrap = document.paths?.[bootstrapPath]?.post;
if (!bootstrap) throw new Error(`OpenAPI contract is missing POST ${bootstrapPath}.`);
if (!bootstrap.security?.some((requirement) => "sessionCookie" in requirement)) {
  throw new Error(`OpenAPI contract is missing sessionCookie security on POST ${bootstrapPath}.`);
}
const bootstrapHeaders = bootstrap.parameters?.map((parameter) => parameter.name) ?? [];
if (!bootstrapHeaders.includes("origin") || !bootstrapHeaders.includes("x-csrf-token")) {
  throw new Error(`OpenAPI contract is missing mutation headers on POST ${bootstrapPath}.`);
}
if (!bootstrap.responses?.["200"] || !bootstrap.responses?.["403"] || !bootstrap.responses?.["409"]) {
  throw new Error(`OpenAPI contract is missing success or rejection responses on POST ${bootstrapPath}.`);
}

console.log("Generated OpenAPI contract is current and valid JSON.");
