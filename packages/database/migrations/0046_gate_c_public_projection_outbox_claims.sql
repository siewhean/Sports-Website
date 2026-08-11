-- A publication becomes visible before the worker may perform its external
-- cache-purge side effect.  Claims are durable so no database transaction is
-- held while calling Redis or the edge bridge.
ALTER TABLE outbox_events
  ADD COLUMN dispatch_claim_id uuid,
  ADD COLUMN dispatch_claimed_at timestamptz,
  ADD COLUMN dispatch_claim_expires_at timestamptz;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_dispatch_claim_shape_check CHECK (
    (dispatch_claim_id IS NULL AND dispatch_claimed_at IS NULL AND dispatch_claim_expires_at IS NULL)
    OR (
      dispatch_claim_id IS NOT NULL
      AND dispatch_claimed_at IS NOT NULL
      AND dispatch_claim_expires_at IS NOT NULL
      AND dispatch_claim_expires_at > dispatch_claimed_at
    )
  );

CREATE INDEX outbox_events_public_projection_dispatch_idx
  ON outbox_events (available_at, dispatch_claim_expires_at, created_at, id)
  WHERE event_type = 'public_projection.published' AND published_at IS NULL;

COMMENT ON COLUMN outbox_events.dispatch_claim_id IS
  'Short-lived worker dispatch lease. It is committed before an external enqueue and cleared only by the matching worker.';
