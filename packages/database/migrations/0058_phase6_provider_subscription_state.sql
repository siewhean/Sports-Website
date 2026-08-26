-- Phase 6: retain the provider's subscription lifecycle state and period
-- boundaries even when the application-level webhook handler is running on an
-- older/default mapping. The immutable webhook receipt is the authoritative
-- provider payload, so normalise the subscription immediately after receipt.

CREATE OR REPLACE FUNCTION phase6_apply_subscription_receipt_state() RETURNS trigger AS $$
DECLARE
  provider_status text;
  normalised_status text;
  period_start_epoch numeric;
  period_end_epoch numeric;
BEGIN
  IF NEW.organisation_id IS NULL OR NEW.event_type <> 'customer.subscription.updated' THEN
    RETURN NEW;
  END IF;

  provider_status := NEW.payload #>> '{data,object,status}';
  IF provider_status IS NULL OR provider_status = '' THEN
    RETURN NEW;
  END IF;

  normalised_status := CASE provider_status
    WHEN 'active' THEN 'active'
    WHEN 'trialing' THEN 'trialing'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'past_due' THEN 'past_due'
    WHEN 'unpaid' THEN 'past_due'
    WHEN 'paused' THEN 'past_due'
    WHEN 'incomplete' THEN 'past_due'
    WHEN 'incomplete_expired' THEN 'canceled'
    ELSE 'past_due'
  END;

  BEGIN
    period_start_epoch := NULLIF(NEW.payload #>> '{data,object,current_period_start}', '')::numeric;
  EXCEPTION WHEN invalid_text_representation THEN
    period_start_epoch := NULL;
  END;
  BEGIN
    period_end_epoch := NULLIF(NEW.payload #>> '{data,object,current_period_end}', '')::numeric;
  EXCEPTION WHEN invalid_text_representation THEN
    period_end_epoch := NULL;
  END;

  UPDATE organisation_subscriptions
  SET status = normalised_status,
      current_period_start = COALESCE(to_timestamp(period_start_epoch), current_period_start),
      current_period_end = COALESCE(to_timestamp(period_end_epoch), current_period_end),
      updated_at = now()
  WHERE organisation_id = NEW.organisation_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_receipts_phase6_subscription_state ON billing_webhook_receipts;
CREATE TRIGGER billing_receipts_phase6_subscription_state
AFTER INSERT ON billing_webhook_receipts
FOR EACH ROW EXECUTE FUNCTION phase6_apply_subscription_receipt_state();
