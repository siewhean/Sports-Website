import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Runtime } from "./phase-3-runtime.js";
import { registerPhase3Routes as registerCorePhase3Routes } from "./phase-3-routes-core.js";

const Id = Type.String({ format: "uuid" });
const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});
const OrganiserCompetitionLibraryResponse = Type.Array(
  Type.Object(
    {
      id: Id,
      organisation_id: Id,
      organisation_name: Type.String({ minLength: 1 }),
      membership_role: Type.Union([Type.Literal("owner"), Type.Literal("organiser")]),
      name: Type.String({ minLength: 1 }),
      slug: Type.String({ minLength: 1 }),
      sport_code: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      starts_on: Type.String({ format: "date" }),
      ends_on: Type.String({ format: "date" }),
      timezone: Type.String({ minLength: 1 }),
      updated_at: Type.String({ format: "date-time" }),
      published: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

type Phase3RouteOptions = {
  runtime: Phase3Runtime;
  identityRuntime: IdentityApiRuntime;
  identityRequests: IdentityRequestContext;
  allowedOrigins: readonly string[];
  registerCanonicalMutations?: boolean;
};

export async function registerPhase3Routes(app: FastifyInstance, options: Phase3RouteOptions) {
  await registerCorePhase3Routes(app, options);

  const readAccountId = async (request: FastifyRequest): Promise<string> =>
    (await options.identityRequests.authenticate(request)).account.id;

  app.get(
    "/api/v1/organiser/competitions",
    {
      schema: {
        description: "List competitions the signed-in account can organise, including private drafts.",
        security: [{ sessionCookie: [] }],
        response: { 200: OrganiserCompetitionLibraryResponse, 401: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store, private");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Cookie");
      return options.runtime.repositories.competition.listByAccountId(await readAccountId(request));
    },
  );
}
