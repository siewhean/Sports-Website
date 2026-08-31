import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { ExportRuntime } from "./export-runtime.js";

const Id = Type.String({ format: "uuid" });
const Json = Type.Unknown();
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const ReadResponses = { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export async function registerExportRoutes(
  app: FastifyInstance,
  options: {
    runtime: ExportRuntime;
    identityRequests?: IdentityRequestContext | undefined;
  },
) {
  const tryActor = async (request: FastifyRequest): Promise<Phase3Actor | undefined> => {
    if (!options.identityRequests) return undefined;
    try {
      const session = await options.identityRequests.authenticate(request);
      return { accountId: session.account.id };
    } catch {
      return undefined;
    }
  };

  const requireActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    if (!options.identityRequests) {
      return { accountId: "anonymous" };
    }
    const session = await options.identityRequests.authenticate(request);
    return { accountId: session.account.id };
  };

  // Matches & Fixtures CSV export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/csv",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const actor = await tryActor(request);
      const csv = await options.runtime.generateCompetitionCsv(request.params.competitionId, actor);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}-matches.csv"`)
        .send(csv);
    },
  );

  // Standings / Group Table CSV export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/standings/csv",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const actor = await tryActor(request);
      const csv = await options.runtime.generateStandingsCsv(request.params.competitionId, actor);
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="competition-${request.params.competitionId}-standings.csv"`,
        )
        .send(csv);
    },
  );

  // Bracket Structure CSV export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/bracket/csv",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const actor = await tryActor(request);
      const csv = await options.runtime.generateBracketCsv(request.params.competitionId, actor);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}-bracket.csv"`)
        .send(csv);
    },
  );

  // Competition Manager Audit Log CSV export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/audit/csv",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const actor = await requireActor(request);
      const csv = await options.runtime.generateAuditHistoryExport(actor, request.params.competitionId);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}-audit.csv"`)
        .send(csv);
    },
  );

  // Full Competition JSON archive export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/json",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const actor = await tryActor(request);
      const json = await options.runtime.generateCompetitionJson(request.params.competitionId, actor);
      return reply
        .type("application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}.json"`)
        .send(json);
    },
  );

  // Validate competition archive
  app.post<{ Body: { archive: unknown } }>(
    "/api/v1/competitions/exports/validate-archive",
    {
      schema: {
        body: Type.Object({ archive: Json }),
        response: { 200: Json, ...ReadResponses },
        tags: ["exports"],
      },
    },
    async (request) => {
      return options.runtime.validateCompetitionArchive(request.body.archive);
    },
  );

  // Import competition archive into organisation
  app.post<{
    Params: { organisationId: string };
    Body: { archive: unknown; renameSuffix?: string };
  }>(
    "/api/v1/organisations/:organisationId/competitions/import-archive",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        body: Type.Object({ archive: Json, renameSuffix: Type.Optional(Type.String()) }),
        response: { 200: Json, ...ReadResponses },
        tags: ["exports"],
      },
    },
    async (request) => {
      const actor = await requireActor(request);
      return options.runtime.importCompetitionArchive(
        actor,
        request.params.organisationId,
        request.body.archive,
        request.body.renameSuffix,
      );
    },
  );
}
