ALTER TABLE feature_flag_overrides
  DROP CONSTRAINT IF EXISTS feature_flag_overrides_scope_type_check;

ALTER TABLE feature_flag_overrides
  ADD CONSTRAINT feature_flag_overrides_scope_type_check
  CHECK (scope_type IN ('platform', 'organisation', 'competition', 'account'));

ALTER TABLE feature_flag_overrides
  ADD CONSTRAINT feature_flag_overrides_key_not_blank
  CHECK (length(btrim(key)) > 0),
  ADD CONSTRAINT feature_flag_overrides_reason_not_blank
  CHECK (length(btrim(reason)) > 0);

CREATE INDEX feature_flag_audit_events_idx
  ON audit_events (target_id, occurred_at DESC)
  WHERE target_type = 'feature_flag';
