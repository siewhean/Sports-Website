-- 0068_pdpa_retention.sql
-- Singapore PDPA retention support: purge-supporting indexes and a narrowly scoped retention
-- exception for scoring_access_attempts. audit_events is NOT touched and stays append-only.

-- scoring_access_attempts was fully append-only (migration 0028). Retention requires removing
-- expired rate-limit evidence, so the guard is replaced (not disabled) with one that still rejects
-- every UPDATE and rejects every DELETE unless ALL of the following hold:
--   * the transaction opted in with set_config('matchday.pdpa_purge','on',true) (transaction-local),
--   * the row is older than a hard 7-day floor regardless of configuration,
--   * the row's rate-limit state has already expired.
CREATE OR REPLACE FUNCTION pdpa_guard_scoring_access_attempt_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('matchday.pdpa_purge', true) = 'on'
     AND OLD.attempted_at < now() - interval '7 days'
     AND OLD.rate_limit_state_expires_at < now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Guarded so partial-chain migration fixtures that apply this file before the referenced tables
-- exist stay valid; on the full chain every table is present and every statement runs.
DO $pdpa_retention$
BEGIN
  IF to_regclass('scoring_access_attempts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS scoring_access_attempts_append_only ON scoring_access_attempts;
    CREATE TRIGGER scoring_access_attempts_append_only
    BEFORE UPDATE OR DELETE ON scoring_access_attempts
    FOR EACH ROW EXECUTE FUNCTION pdpa_guard_scoring_access_attempt_mutation();
    -- Retention scans are batch-limited and ordered by age; these keep them index-driven.
    CREATE INDEX IF NOT EXISTS scoring_access_attempts_attempted_idx ON scoring_access_attempts(attempted_at);
  END IF;
  IF to_regclass('identity_sessions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS identity_sessions_absolute_expiry_idx ON identity_sessions(absolute_expires_at);
    CREATE INDEX IF NOT EXISTS identity_sessions_idle_expiry_idx ON identity_sessions(idle_expires_at);
    CREATE INDEX IF NOT EXISTS identity_sessions_revoked_idx ON identity_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
  END IF;
  IF to_regclass('identity_recovery_requests') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS identity_recovery_requests_expiry_idx ON identity_recovery_requests(expires_at);
  END IF;
  IF to_regclass('notifications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at);
  END IF;
  IF to_regclass('billing_webhook_receipts') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS billing_webhook_receipts_created_idx ON billing_webhook_receipts(created_at);
  END IF;
  IF to_regclass('notification_email_delivery_events') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS notification_email_delivery_events_received_idx
      ON notification_email_delivery_events(received_at);
  END IF;
  IF to_regclass('casual_games') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS casual_games_unclaimed_created_idx ON casual_games(created_at) WHERE owner_account_id IS NULL;
  END IF;
END;
$pdpa_retention$;
