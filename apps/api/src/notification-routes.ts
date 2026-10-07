import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import { parseResendDeliveryEvent, type NotificationService } from "@matchday/notifications";
import type { EmailDeliveryEventMetricRecorder } from "./email-delivery-metrics.js";

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
    emailWebhookSecret?: string | undefined;
    metrics?: EmailDeliveryEventMetricRecorder | undefined;
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

  // Transactional Email Delivery Webhook (Resend)
  app.post(
    "/api/v1/notifications/webhooks/resend",
    {
      schema: {
        response: { 200: Json, ...MutationErrors },
        tags: ["notifications"],
      },
    },
    async (request) => {
      const secret = options.emailWebhookSecret ?? process.env.EMAIL_PROVIDER_WEBHOOK_SECRET;
      if (!secret || secret.trim() === "") {
        options.metrics?.recordRejection("resend", "unconfigured_secret");
        throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "Email provider webhook authentication not configured");
      }

      const msgId = request.headers["svix-id"] as string | undefined;
      const timestamp = request.headers["svix-timestamp"] as string | undefined;
      const signature = request.headers["svix-signature"] as string | undefined;

      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);

      let eventInput;
      try {
        eventInput = parseResendDeliveryEvent({ msgId, timestamp, signature }, rawBody, secret);
      } catch (err: unknown) {
        options.metrics?.recordRejection("resend", "auth_or_parse_failure");
        throw new ApiError(
          401,
          ErrorCode.AUTHENTICATION_REQUIRED,
          (err as Error).message || "Invalid webhook signature or payload",
        );
      }

      let result;
      try {
        result = await options.notificationService.recordDeliveryEvent(eventInput);
      } catch (err: unknown) {
        request.log.error({ err }, "recordDeliveryEvent error");
        console.error("DEBUG recordDeliveryEvent failed:", err);
        throw err;
      }

      if (result.isDuplicate) {
        options.metrics?.recordEvent(eventInput.provider, eventInput.eventType, "duplicate");
      } else {
        options.metrics?.recordEvent(eventInput.provider, eventInput.eventType, "processed");
        if (eventInput.eventType === "bounced") {
          options.metrics?.recordBounce(eventInput.provider, eventInput.bounceType ?? "unknown");
        } else if (eventInput.eventType === "complained") {
          options.metrics?.recordComplaint(eventInput.provider);
        }
      }

      return {
        received: true,
        event_id: result.event.id,
        provider_event_id: result.event.providerEventId,
        is_duplicate: result.isDuplicate,
        outbox_updated: result.outboxItem !== null,
      };
    },
  );
}
