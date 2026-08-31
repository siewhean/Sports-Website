-- Phase 6: enforce entry limits from the organisation's effective subscription.
-- Purchased tiers must apply to existing competitions, while a lapsed subscription
-- must stop new free-tier-exceeding entries without destructively removing entries.

CREATE OR REPLACE FUNCTION matchday_effective_plan_tier(target_competition uuid) RETURNS text AS $$
DECLARE
  fallback_tier text;
  subscription_tier text;
  subscription_status text;
  subscription_period_end timestamptz;
BEGIN
  SELECT c.plan_tier, s.tier, s.status, s.current_period_end
    INTO fallback_tier, subscription_tier, subscription_status, subscription_period_end
  FROM competitions c
  LEFT JOIN organisation_subscriptions s ON s.organisation_id = c.organisation_id
  WHERE c.id = target_competition;

  IF fallback_tier IS NULL THEN
    RETURN 'free';
  END IF;

  -- No billing row means this is a legacy/manual entitlement and the persisted
  -- competition tier remains authoritative.
  IF subscription_status IS NULL THEN
    RETURN fallback_tier;
  END IF;

  IF subscription_status IN ('active', 'trialing')
     AND (subscription_period_end IS NULL OR subscription_period_end > now()) THEN
    RETURN COALESCE(subscription_tier, 'free');
  END IF;

  RETURN 'free';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase6_sync_paid_subscription_competition_tier() RETURNS trigger AS $$
BEGIN
  IF NEW.tier <> 'free'
     AND NEW.status IN ('active', 'trialing')
     AND (NEW.current_period_end IS NULL OR NEW.current_period_end > now()) THEN
    UPDATE competitions
       SET plan_tier = NEW.tier,
           updated_at = now()
     WHERE organisation_id = NEW.organisation_id
       AND plan_tier IS DISTINCT FROM NEW.tier;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organisation_subscriptions_phase6_competition_tier_sync ON organisation_subscriptions;
CREATE TRIGGER organisation_subscriptions_phase6_competition_tier_sync
AFTER INSERT OR UPDATE OF tier, status, current_period_end ON organisation_subscriptions
FOR EACH ROW EXECUTE FUNCTION phase6_sync_paid_subscription_competition_tier();

-- Bring existing active paid subscriptions into alignment when this migration is
-- applied to a live database.
UPDATE competitions c
SET plan_tier = s.tier,
    updated_at = now()
FROM organisation_subscriptions s
WHERE s.organisation_id = c.organisation_id
  AND s.tier <> 'free'
  AND s.status IN ('active', 'trialing')
  AND (s.current_period_end IS NULL OR s.current_period_end > now())
  AND c.plan_tier IS DISTINCT FROM s.tier;

CREATE OR REPLACE FUNCTION phase3_enforce_free_entry_limit() RETURNS trigger AS $$
DECLARE
  target_competition uuid;
  tier text;
  active_count integer;
BEGIN
  IF NEW.status NOT IN ('confirmed','active') THEN RETURN NEW; END IF;
  SELECT competition_id INTO target_competition FROM divisions WHERE id = NEW.division_id;
  -- Keep the competition row as the serialization lock for entry writes, then
  -- derive entitlement from the owning organisation's current subscription.
  PERFORM 1 FROM competitions WHERE id = target_competition FOR UPDATE;
  tier := matchday_effective_plan_tier(target_competition);
  IF tier <> 'free' THEN RETURN NEW; END IF;
  SELECT count(*) INTO active_count
  FROM division_entries e JOIN divisions d ON d.id = e.division_id
  WHERE d.competition_id = target_competition
    AND e.status IN ('confirmed','active') AND e.id <> NEW.id;
  IF active_count >= 16 THEN
    RAISE EXCEPTION 'free plan permits at most 16 active entries per competition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
