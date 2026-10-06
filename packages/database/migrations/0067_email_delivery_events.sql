-- 0067_email_delivery_events.sql
-- Durable, idempotent transactional-email delivery events (OPS-017)

-- Add index on provider_message_id in outbox to correlate incoming provider events
CREATE INDEX IF NOT EXISTS notification_email_outbox_provider_message_id_idx
ON notification_email_outbox(provider_message_id)
WHERE provider_message_id IS NOT NULL;

-- Immutable audit log for provider delivery events (delivered, bounced, complained, delayed, failed)
CREATE TABLE IF NOT EXISTS notification_email_delivery_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_message_id text NOT NULL,
  outbox_id uuid REFERENCES notification_email_outbox(id) ON DELETE SET NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('delivered', 'bounced', 'complained', 'delivery_delayed', 'delivery_failed')),
  bounce_type text
    CHECK (bounce_type IS NULL OR bounce_type IN ('hard', 'soft', 'general')),
  bounce_sub_type text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recipient_reference text,
  diagnostic_code text,
  CONSTRAINT notification_email_delivery_events_provider_event_unique
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS notification_email_delivery_events_outbox_idx
ON notification_email_delivery_events(outbox_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS notification_email_delivery_events_msg_idx
ON notification_email_delivery_events(provider_message_id, occurred_at DESC);
