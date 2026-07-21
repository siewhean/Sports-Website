ALTER TABLE notifications
ADD COLUMN idempotency_key text;

UPDATE notifications
SET idempotency_key = 'legacy:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE notifications
ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX notifications_account_idempotency_unique
ON notifications(account_id, idempotency_key);

CREATE TABLE notification_email_outbox (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  to_address text NOT NULL CHECK (length(trim(to_address)) > 0),
  template_id text NOT NULL,
  template_version integer NOT NULL CHECK (template_version > 0),
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  locked_until timestamptz,
  lease_token text,
  delivered_at timestamptz,
  provider_message_id text,
  last_error text,
  last_failure_classification text
    CHECK (last_failure_classification IS NULL OR last_failure_classification IN ('transient', 'permanent')),
  CHECK (
    (status = 'processing' AND locked_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'processing' AND locked_until IS NULL AND lease_token IS NULL)
  ),
  CHECK ((status = 'delivered' AND delivered_at IS NOT NULL) OR status <> 'delivered')
);

CREATE INDEX notification_email_outbox_due_idx
ON notification_email_outbox(available_at, created_at)
WHERE status IN ('pending', 'processing');

CREATE INDEX notification_email_outbox_notification_idx
ON notification_email_outbox(notification_id);
