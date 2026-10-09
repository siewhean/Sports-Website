-- Week-2 security hardening.
--
-- 1. Billing webhook receipts used to store the full Stripe event, including customer_details
--    (name, email, address, phone). The API now stores only an allow-listed projection; rewrite
--    historical rows to the same projection so the PII does not linger. The receipt trigger from
--    0058 (AFTER INSERT) reads data.object.status/current_period_* which are kept.
-- Earlier API versions bound the payload as a jsonb parameter, so the driver double-encoded it and
-- rows hold a JSON string scalar. Unwrap those first so the projection below can read them.
-- Guarded so partial-chain migration fixtures that apply this file before 0055 stay valid.
DO $w2sec_billing$
BEGIN
  IF to_regclass('billing_webhook_receipts') IS NULL THEN
    RETURN;
  END IF;
  UPDATE billing_webhook_receipts
  SET payload = (payload #>> '{}')::jsonb
  WHERE jsonb_typeof(payload) = 'string';

  UPDATE billing_webhook_receipts r
  SET payload = jsonb_build_object(
    'id', r.payload->>'id',
    'type', r.payload->>'type',
    'created', CASE WHEN jsonb_typeof(r.payload->'created') = 'number' THEN r.payload->'created' END,
    'data', jsonb_build_object('object', jsonb_build_object(
      'id', r.payload #>> '{data,object,id}',
      'mode', r.payload #>> '{data,object,mode}',
      'payment_status', r.payload #>> '{data,object,payment_status}',
      'status', r.payload #>> '{data,object,status}',
      'amount_total', CASE WHEN jsonb_typeof(r.payload #> '{data,object,amount_total}') = 'number'
                           THEN r.payload #> '{data,object,amount_total}' END,
      'currency', r.payload #>> '{data,object,currency}',
      'customer', CASE WHEN jsonb_typeof(r.payload #> '{data,object,customer}') = 'string'
                       THEN r.payload #>> '{data,object,customer}' END,
      'subscription', CASE WHEN jsonb_typeof(r.payload #> '{data,object,subscription}') = 'string'
                           THEN r.payload #>> '{data,object,subscription}' END,
      'client_reference_id', r.payload #>> '{data,object,client_reference_id}',
      'current_period_start', CASE WHEN jsonb_typeof(r.payload #> '{data,object,current_period_start}') = 'number'
                                   THEN r.payload #> '{data,object,current_period_start}' END,
      'current_period_end', CASE WHEN jsonb_typeof(r.payload #> '{data,object,current_period_end}') = 'number'
                                 THEN r.payload #> '{data,object,current_period_end}' END,
      'metadata', jsonb_build_object(
        'organisation_id', r.payload #>> '{data,object,metadata,organisation_id}',
        'competition_id', r.payload #>> '{data,object,metadata,competition_id}',
        'tier', r.payload #>> '{data,object,metadata,tier}',
        'purchase_type', r.payload #>> '{data,object,metadata,purchase_type}',
        'top_up_units', r.payload #>> '{data,object,metadata,top_up_units}'
      )
    ))
  )
  WHERE r.payload ? 'data'
    AND (
      r.payload #> '{data,object}' ? 'customer_details'
      OR r.payload #> '{data,object}' ? 'customer_email'
      OR r.payload ? 'request'
      OR r.payload ? 'livemode'
    );
END
$w2sec_billing$;

-- 2. Anonymous casual games expire after 30 idle days (CASUAL_ANONYMOUS_GAME_TTL_DAYS); this
--    partial index keeps purgeExpiredCasualGames() an index range scan.
DO $w2sec_casual$
BEGIN
  IF to_regclass('casual_games') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS casual_games_unclaimed_updated_idx
      ON casual_games (updated_at)
      WHERE owner_account_id IS NULL;
  END IF;
END
$w2sec_casual$;
