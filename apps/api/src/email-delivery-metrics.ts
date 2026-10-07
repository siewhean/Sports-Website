import type { Meter } from "@opentelemetry/api";

export interface EmailDeliveryEventMetricRecorder {
  recordEvent(provider: string, eventType: string, result: "processed" | "duplicate" | "rejected"): void;
  recordRejection(provider: string, reason: string): void;
  recordBounce(provider: string, bounceType: string): void;
  recordComplaint(provider: string): void;
}

export const noopEmailDeliveryEventMetrics: EmailDeliveryEventMetricRecorder = {
  recordEvent: () => undefined,
  recordRejection: () => undefined,
  recordBounce: () => undefined,
  recordComplaint: () => undefined,
};

export function createEmailDeliveryEventMetrics(meter: Meter): EmailDeliveryEventMetricRecorder {
  const eventsCounter = meter.createCounter("email_provider_events_total", {
    description: "Total incoming transactional email provider delivery events",
    unit: "{event}",
  });

  const rejectionsCounter = meter.createCounter("email_provider_event_rejections_total", {
    description: "Total rejected transactional email provider delivery events",
    unit: "{rejection}",
  });

  const bouncesCounter = meter.createCounter("email_bounces_total", {
    description: "Total email bounce events recorded",
    unit: "{bounce}",
  });

  const complaintsCounter = meter.createCounter("email_complaints_total", {
    description: "Total email spam complaints recorded",
    unit: "{complaint}",
  });

  return {
    recordEvent(provider, eventType, result) {
      try {
        eventsCounter.add(1, { provider, event_type: eventType, result });
      } catch {
        // Telemetry failure must remain nonfatal
      }
    },
    recordRejection(provider, reason) {
      try {
        rejectionsCounter.add(1, { provider, reason });
      } catch {
        // Telemetry failure must remain nonfatal
      }
    },
    recordBounce(provider, bounceType) {
      try {
        bouncesCounter.add(1, { provider, bounce_type: bounceType });
      } catch {
        // Telemetry failure must remain nonfatal
      }
    },
    recordComplaint(provider) {
      try {
        complaintsCounter.add(1, { provider });
      } catch {
        // Telemetry failure must remain nonfatal
      }
    },
  };
}
