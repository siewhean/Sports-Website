import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
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
  },
) {
  // Public / Organiser CSV export
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/csv",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        tags: ["exports"],
      },
    },
    async (request, reply) => {
      const csv = await options.runtime.generateCompetitionCsv(request.params.competitionId);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}-matches.csv"`)
        .send(csv);
    },
  );

  // Public / Organiser JSON export
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
      const json = await options.runtime.generateCompetitionJson(request.params.competitionId);
      return reply
        .type("application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="competition-${request.params.competitionId}.json"`)
        .send(json);
    },
  );
}
