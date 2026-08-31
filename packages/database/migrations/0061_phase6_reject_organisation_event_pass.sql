-- Subscription expiry must stop new over-free-limit entries, but it must not
-- rewrite a competition back to `free` when it already has more than sixteen
-- active entries. `matchday_effective_plan_tier()` derives the live entitlement
-- from the subscription status, while the persisted tier remains a harmless
-- historical materialisation until the organiser brings the entry count down.
CREATE OR REPLACE FUNCTION phase6_sync_paid_subscription_competition_tier()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tier = 'organiser_pro'
     AND NEW.status IN ('active', 'trialing')
     AND (NEW.current_period_end IS NULL OR NEW.current_period_end > now()) THEN
    UPDATE competitions
    SET plan_tier = 'organiser_pro', updated_at = now()
    WHERE organisation_id = NEW.organisation_id
      AND plan_tier IS DISTINCT FROM 'organiser_pro';
  END IF;
  RETURN NEW;
END;
$$;

-- Event Passes are competition-scoped. Replace the old subscription-sync
-- function before neutralising legacy rows: the old function would attempt to
-- rewrite competition tiers and can violate the non-destructive free-limit
-- guard for competitions that already have more than sixteen entries.
UPDATE organisation_subscriptions
SET tier = 'free',
    status = 'canceled',
    current_period_end = COALESCE(current_period_end, now()),
    updated_at = now()
WHERE tier = 'event_pass';

CREATE OR REPLACE FUNCTION phase6_reject_organisation_event_pass()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tier = 'event_pass' THEN
    RAISE EXCEPTION 'Event Pass entitlement must be scoped to a competition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organisation_subscriptions_reject_event_pass ON organisation_subscriptions;
CREATE TRIGGER organisation_subscriptions_reject_event_pass
BEFORE INSERT OR UPDATE OF tier ON organisation_subscriptions
FOR EACH ROW EXECUTE FUNCTION phase6_reject_organisation_event_pass();

-- A persisted competition tier is legacy/manual state only when there is no
-- subscription record. Once an organisation has a billing record, entitlement
-- is determined exclusively from an active Organiser Pro subscription or a
-- scoped Event Pass grant. This keeps lapsed paid organisations at the free
-- limit without destructively changing their historical competition row.
CREATE OR REPLACE FUNCTION matchday_effective_plan_tier(target_competition uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM organisation_subscriptions s
      WHERE s.organisation_id = c.organisation_id
        AND s.tier = 'organiser_pro'
        AND s.status IN ('active', 'trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end > now())
    ) THEN 'organiser_pro'
    WHEN EXISTS (
      SELECT 1
      FROM entitlement_grants g
      WHERE g.organisation_id = c.organisation_id
        AND g.competition_id = c.id
        AND g.tier = 'event_pass'
        AND g.source IN ('purchase', 'admin_grant')
        AND (g.expires_at IS NULL OR g.expires_at > now())
    ) THEN 'event_pass'
    WHEN c.plan_tier = 'organiser_pro'
      AND NOT EXISTS (
        SELECT 1
        FROM organisation_subscriptions s
        WHERE s.organisation_id = c.organisation_id
      ) THEN 'organiser_pro'
    ELSE 'free'
  END
  FROM competitions c
  WHERE c.id = target_competition
$$;
