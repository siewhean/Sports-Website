-- Phase 6 remediation: an Event Pass belongs to one named competition and its event range.
-- Organiser Pro remains organisation-wide. Legacy organisation-level Event Pass state is
-- only honoured when the organisation has exactly one competition, preventing sibling leaks.

CREATE INDEX IF NOT EXISTS idx_entitlement_grants_competition_event_pass
  ON entitlement_grants (competition_id, expires_at)
  WHERE tier = 'event_pass' AND competition_id IS NOT NULL;

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
    WHEN c.plan_tier = 'organiser_pro' THEN 'organiser_pro'
    WHEN c.plan_tier = 'event_pass'
      AND c.ends_on >= current_date
      AND EXISTS (
        SELECT 1
        FROM organisation_subscriptions legacy
        WHERE legacy.organisation_id = c.organisation_id
          AND legacy.tier = 'event_pass'
          AND legacy.status IN ('active', 'trialing')
          AND (legacy.current_period_end IS NULL OR legacy.current_period_end > now())
      )
      AND 1 = (
        SELECT count(*)
        FROM competitions sibling
        WHERE sibling.organisation_id = c.organisation_id
      )
    THEN 'event_pass'
    ELSE 'free'
  END
  FROM competitions c
  WHERE c.id = target_competition
$$;

-- Only Organiser Pro is organisation-wide. Event Pass access is represented by a
-- competition-scoped entitlement_grants row written by the billing webhook.
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
  ELSIF TG_OP = 'UPDATE'
        AND OLD.tier = 'organiser_pro'
        AND OLD.status IN ('active', 'trialing')
        AND NOT (
          NEW.tier = 'organiser_pro'
          AND NEW.status IN ('active', 'trialing')
          AND (NEW.current_period_end IS NULL OR NEW.current_period_end > now())
        ) THEN
    UPDATE competitions
    SET plan_tier = 'free', updated_at = now()
    WHERE organisation_id = NEW.organisation_id
      AND plan_tier = 'organiser_pro';
  END IF;
  RETURN NEW;
END;
$$;

-- Remove the inherited organisation-wide Event Pass materialisation introduced by 0057.
-- Scoped grants now provide the paid competition tier. A one-competition legacy purchase
-- remains readable through matchday_effective_plan_tier() without leaking to future siblings.
UPDATE competitions c
SET plan_tier = 'free', updated_at = now()
WHERE c.plan_tier = 'event_pass'
  AND EXISTS (
    SELECT 1
    FROM organisation_subscriptions s
    WHERE s.organisation_id = c.organisation_id
      AND s.tier = 'event_pass'
  );

-- Re-assert Organiser Pro materialisation after the cleanup above.
UPDATE competitions c
SET plan_tier = 'organiser_pro', updated_at = now()
FROM organisation_subscriptions s
WHERE c.organisation_id = s.organisation_id
  AND s.tier = 'organiser_pro'
  AND s.status IN ('active', 'trialing')
  AND (s.current_period_end IS NULL OR s.current_period_end > now())
  AND c.plan_tier IS DISTINCT FROM 'organiser_pro';
