import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Runtime } from "./phase-3-runtime.js";

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

export async function registerOrganiserCompetitionLibraryRoutes(
  app: FastifyInstance,
  options: { runtime: Phase3Runtime; identityRequests: IdentityRequestContext },
) {
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
      const accountId = (await options.identityRequests.authenticate(request)).account.id;
      reply.header("Cache-Control", "no-store, private");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Cookie");
      return options.runtime.repositories.competition.listByAccountId(accountId);
    },
  );
}
