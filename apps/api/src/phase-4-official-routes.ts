import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { Phase4Runtime } from "./phase-4-runtime.js";

const Id = Type.String({ format: "uuid" });
const Json = Type.Unknown();
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  { origin: Type.String({ minLength: 1 }), "x-csrf-token": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const MutationResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  503: ErrorResponse,
};
const ReadResponses = { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

function rejectUnknownBodyFields(allowed: readonly string[]) {
  const expected = new Set(allowed);
  return async (request: FastifyRequest) => {
    const body = request.body;
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).some((field) => !expected.has(field))
    )
      throw new ApiError(400, ErrorCode.REQUEST_INVALID, "Request body contains an unknown field");
  };
}

const CreateOfficialBody = strict({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  default_role: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 40 })])),
});

const UpdateOfficialBody = strict({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  default_role: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 40 })])),
});

const ReplaceAvailabilityBody = strict({
  windows: Type.Array(
    strict({
      starts_at: Type.String({ format: "date-time" }),
      ends_at: Type.String({ format: "date-time" }),
    }),
    { maxItems: 512 },
  ),
});

const ReplaceMatchOfficialsBody = strict({
  assignments: Type.Array(
    strict({
      official_id: Id,
      assigned_role: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 40 })])),
    }),
    { maxItems: 64 },
  ),
});

const OfficialResponse = strict({
  id: Id,
  competition_id: Id,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  default_role: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
  archived: Type.Boolean(),
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
});

const OfficialsListResponse = strict({
  items: Type.Array(OfficialResponse),
});

const AvailabilityWindowResponse = strict({
  starts_at: Type.String({ format: "date-time" }),
  ends_at: Type.String({ format: "date-time" }),
});

const AvailabilityResponse = strict({
  windows: Type.Array(AvailabilityWindowResponse),
});

const AvailabilityMutationResponse = strict({
  windows: Type.Array(AvailabilityWindowResponse),
  bumped_revision: Type.Boolean(),
});

const MatchOfficialAssignmentResponse = strict({
  match_id: Id,
  official_id: Id,
  assigned_role: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
  official: Type.Optional(
    strict({
      id: Id,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      default_role: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
      archived: Type.Boolean(),
    }),
  ),
});

const MatchOfficialsResponse = strict({
  assignments: Type.Array(MatchOfficialAssignmentResponse),
});

const MatchOfficialsMutationResponse = strict({
  assignments: Type.Array(MatchOfficialAssignmentResponse),
  bumped_revision: Type.Boolean(),
});

const OfficialMutationResponse = strict({
  official: OfficialResponse,
  bumped_revision: Type.Boolean(),
});

const OfficialWorkspaceResponse = strict({
  officials: Type.Array(OfficialResponse),
  availability: Type.Record(Id, Type.Array(AvailabilityWindowResponse)),
  assignments: Type.Array(MatchOfficialAssignmentResponse),
});

export async function registerPhase4OfficialRoutes(
  app: FastifyInstance,
  options: {
    runtime: Phase4Runtime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => ({
    accountId: (await options.identityRequests.authenticate(request)).account.id,
  });

  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin))
      throw new ApiError(403, ErrorCode.ORIGIN_REJECTED, "Request origin is not allowed");
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf))
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    return { accountId: session.account.id };
  };

  const read = { security: [{ sessionCookie: [] }], response: { 200: Json, ...ReadResponses } };
  const mutation = { security: [{ sessionCookie: [] }], headers: MutationHeaders };

  // Register routes on paths
  const registerRoutesForPrefix = (prefix: string) => {
    // 1. List officials
    app.get<{
      Params: { competitionId: string };
      Querystring: { include_archived?: boolean };
    }>(
      `${prefix}/competitions/:competitionId/officials`,
      {
        schema: {
          ...read,
          params: strict({ competitionId: Id }),
          querystring: strict({ include_archived: Type.Optional(Type.Boolean()) }),
          response: { 200: OfficialsListResponse, ...ReadResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await readActor(request);
        return options.runtime.listOfficials(actor, request.params.competitionId, {
          includeArchived: request.query.include_archived ?? false,
        });
      },
    );

    // 2. Get single official
    app.get<{
      Params: { competitionId: string; officialId: string };
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId`,
      {
        schema: {
          ...read,
          params: strict({ competitionId: Id, officialId: Id }),
          response: { 200: OfficialResponse, ...ReadResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await readActor(request);
        return options.runtime.getOfficial(actor, request.params.competitionId, request.params.officialId);
      },
    );

    // 3. Create official
    app.post<{
      Params: { competitionId: string };
      Body: Static<typeof CreateOfficialBody>;
    }>(
      `${prefix}/competitions/:competitionId/officials`,
      {
        preValidation: rejectUnknownBodyFields(["name", "default_role"]),
        schema: {
          ...mutation,
          params: strict({ competitionId: Id }),
          body: CreateOfficialBody,
          response: { 201: OfficialResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request, reply) => {
        const actor = await mutationActor(request);
        const result = await options.runtime.createOfficial(
          actor,
          request.params.competitionId,
          request.body,
          request.id,
        );
        reply.code(201).send(result);
      },
    );

    // 3. Update official metadata
    app.patch<{
      Params: { competitionId: string; officialId: string };
      Body: Static<typeof UpdateOfficialBody>;
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId`,
      {
        preValidation: rejectUnknownBodyFields(["name", "default_role"]),
        schema: {
          ...mutation,
          params: strict({ competitionId: Id, officialId: Id }),
          body: UpdateOfficialBody,
          response: { 200: OfficialResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await mutationActor(request);
        return options.runtime.updateOfficial(
          actor,
          request.params.competitionId,
          request.params.officialId,
          request.body,
          request.id,
        );
      },
    );

    // 4. Archive official
    app.post<{
      Params: { competitionId: string; officialId: string };
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId/archive`,
      {
        schema: {
          ...mutation,
          params: strict({ competitionId: Id, officialId: Id }),
          response: { 200: OfficialMutationResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await mutationActor(request);
        return options.runtime.archiveOfficial(
          actor,
          request.params.competitionId,
          request.params.officialId,
          request.id,
        );
      },
    );

    // 5. Restore official
    app.post<{
      Params: { competitionId: string; officialId: string };
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId/restore`,
      {
        schema: {
          ...mutation,
          params: strict({ competitionId: Id, officialId: Id }),
          response: { 200: OfficialMutationResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await mutationActor(request);
        return options.runtime.restoreOfficial(
          actor,
          request.params.competitionId,
          request.params.officialId,
          request.id,
        );
      },
    );

    // 6. Get official availability
    app.get<{
      Params: { competitionId: string; officialId: string };
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId/availability`,
      {
        schema: {
          ...read,
          params: strict({ competitionId: Id, officialId: Id }),
          response: { 200: AvailabilityResponse, ...ReadResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await readActor(request);
        return options.runtime.getOfficialAvailability(actor, request.params.competitionId, request.params.officialId);
      },
    );

    // 7. Replace official availability
    app.put<{
      Params: { competitionId: string; officialId: string };
      Body: Static<typeof ReplaceAvailabilityBody>;
    }>(
      `${prefix}/competitions/:competitionId/officials/:officialId/availability`,
      {
        preValidation: rejectUnknownBodyFields(["windows"]),
        schema: {
          ...mutation,
          params: strict({ competitionId: Id, officialId: Id }),
          body: ReplaceAvailabilityBody,
          response: { 200: AvailabilityMutationResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await mutationActor(request);
        return options.runtime.replaceOfficialAvailability(
          actor,
          request.params.competitionId,
          request.params.officialId,
          request.body.windows,
          request.id,
        );
      },
    );

    // 8. Get match officials
    app.get<{
      Params: { competitionId: string; matchId: string };
    }>(
      `${prefix}/competitions/:competitionId/matches/:matchId/officials`,
      {
        schema: {
          ...read,
          params: strict({ competitionId: Id, matchId: Id }),
          response: { 200: MatchOfficialsResponse, ...ReadResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await readActor(request);
        return options.runtime.getMatchOfficials(actor, request.params.competitionId, request.params.matchId);
      },
    );

    // 9. Replace match officials
    app.put<{
      Params: { competitionId: string; matchId: string };
      Body: Static<typeof ReplaceMatchOfficialsBody>;
    }>(
      `${prefix}/competitions/:competitionId/matches/:matchId/officials`,
      {
        preValidation: rejectUnknownBodyFields(["assignments"]),
        schema: {
          ...mutation,
          params: strict({ competitionId: Id, matchId: Id }),
          body: ReplaceMatchOfficialsBody,
          response: { 200: MatchOfficialsMutationResponse, ...MutationResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await mutationActor(request);
        return options.runtime.replaceMatchOfficials(
          actor,
          request.params.competitionId,
          request.params.matchId,
          request.body.assignments,
          request.id,
        );
      },
    );

    // 10. Official workspace (all-in-one read for organiser)
    app.get<{
      Params: { competitionId: string };
    }>(
      `${prefix}/competitions/:competitionId/officials/workspace`,
      {
        schema: {
          ...read,
          params: strict({ competitionId: Id }),
          response: { 200: OfficialWorkspaceResponse, ...ReadResponses },
          tags: ["phase4-officials"],
        },
      },
      async (request) => {
        const actor = await readActor(request);
        return options.runtime.getOfficialWorkspace(actor, request.params.competitionId);
      },
    );
  };

  // Register both /api/v1/phase4 and /api/v1 prefixes
  registerRoutesForPrefix("/api/v1/phase4");
  registerRoutesForPrefix("/api/v1");
}
