import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { NotificationService } from "@matchday/notifications";

const Json = Type.Unknown();
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const ReadErrors = { 401: ErrorResponse, 403: ErrorResponse };
const MutationErrors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export async function registerNotificationRoutes(
  app: FastifyInstance,
  options: {
    notificationService: NotificationService;
    identityRequests: IdentityRequestContext;
  },
) {
  const readActor = async (request: FastifyRequest) => {
    const session = await options.identityRequests.authenticate(request);
    return { accountId: session.account.id };
  };

  const mutationActor = async (request: FastifyRequest) => {
    const session = await options.identityRequests.authenticate(request);
    const csrfHeader = request.headers["x-csrf-token"];
    if (!csrfHeader || csrfHeader !== session.csrfToken) {
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    }
    return { accountId: session.account.id };
  };

  // List notifications (inbox + unread count)
  app.get(
    "/api/v1/notifications",
    { schema: { response: { 200: Json, ...ReadErrors }, tags: ["notifications"] } },
    async (request) => {
      const actor = await readActor(request);
      return options.notificationService.list(actor.accountId);
    },
  );

  // Mark one notification as read
  app.post<{ Params: { notificationId: string } }>(
    "/api/v1/notifications/:notificationId/read",
    {
      schema: {
        params: Type.Object({ notificationId: Type.String({ format: "uuid" }) }),
        response: { 200: Json, ...MutationErrors },
        tags: ["notifications"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      const result = await options.notificationService.markRead(actor.accountId, request.params.notificationId);
      if (!result) throw new ApiError(404, ErrorCode.NOT_FOUND, "Notification not found");
      return result;
    },
  );

  // Mark all notifications as read
  app.post(
    "/api/v1/notifications/read-all",
    { schema: { response: { 200: Json, ...MutationErrors }, tags: ["notifications"] } },
    async (request) => {
      const actor = await mutationActor(request);
      const count = await options.notificationService.markAllRead(actor.accountId);
      return { marked_read: count };
    },
  );

  // Get preference for a notification type
  app.get<{ Params: { notificationType: string } }>(
    "/api/v1/notifications/preferences/:notificationType",
    {
      schema: {
        params: Type.Object({ notificationType: Type.String({ minLength: 1 }) }),
        response: { 200: Json, ...ReadErrors },
        tags: ["notifications"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.notificationService.getPreference(actor.accountId, request.params.notificationType);
    },
  );

  // Update preference for a notification type
  app.put<{
    Params: { notificationType: string };
    Body: { in_app_enabled: boolean; email_enabled: boolean };
  }>(
    "/api/v1/notifications/preferences/:notificationType",
    {
      schema: {
        params: Type.Object({ notificationType: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          in_app_enabled: Type.Boolean(),
          email_enabled: Type.Boolean(),
        }),
        response: { 200: Json, ...MutationErrors },
        tags: ["notifications"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.notificationService.updatePreference({
        accountId: actor.accountId,
        notificationType: request.params.notificationType,
        inAppEnabled: request.body.in_app_enabled,
        emailEnabled: request.body.email_enabled,
      });
    },
  );
}
