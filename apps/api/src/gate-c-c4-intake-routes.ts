import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { GateCC4LifecycleOperations } from "./gate-c-c4-lifecycle.js";
import type { IdentityRequestContext } from "./identity-routes.js";

const Id = Type.String({ format: "uuid" });
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const PendingCase = strict({
  result_repair_case_id: Id,
  correction_transaction_id: Id,
  corrected_match_id: Id,
  corrected_match_code: Type.String({ minLength: 1 }),
  division_id: Id,
  division_name: Type.String({ minLength: 1 }),
  source_result_version: Type.Integer({ minimum: 1 }),
  created_at: Type.String({ format: "date-time" }),
});

export async function registerGateCC4IntakeRoutes(
  app: FastifyInstance,
  options: {
    lifecycle: GateCC4LifecycleOperations;
    identityRequests: IdentityRequestContext;
  },
) {
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/repairs/pending",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: strict({ competitionId: Id }),
        response: { 200: Type.Array(PendingCase), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["gate-c-c4"],
      },
    },
    async (request) => {
      const session = await options.identityRequests.authenticate(request);
      return options.lifecycle.listPendingCases({ accountId: session.account.id }, request.params.competitionId);
    },
  );
}
