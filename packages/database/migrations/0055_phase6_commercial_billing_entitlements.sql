-- Phase 6: Commercial Billing & Entitlements Foundation (BIL-001 through BIL-014)

CREATE TABLE IF NOT EXISTS organisation_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('free', 'event_pass', 'organiser_pro')),
  status text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'trialing')) DEFAULT 'active',
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id)
);

CREATE TABLE IF NOT EXISTS entitlement_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  competition_id uuid REFERENCES competitions(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('free', 'event_pass', 'organiser_pro')),
  feature text NOT NULL,
  source text NOT NULL CHECK (source IN ('subscription', 'purchase', 'top_up', 'admin_grant')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  idempotency_key text UNIQUE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_grants_org_idx ON entitlement_grants(organisation_id, feature, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('processed', 'failed', 'ignored')),
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  metric text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_usage_org_metric_idx ON billing_usage_events(organisation_id, metric, created_at DESC);

CREATE TABLE IF NOT EXISTS competition_branding (
  competition_id uuid PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  primary_color text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_url text,
  banner_url text,
  hide_platform_badge boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS competition_sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  tier text NOT NULL CHECK (tier IN ('headline', 'tier1', 'tier2', 'community')) DEFAULT 'community',
  logo_url text,
  website_url text,
  sort_order smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS competition_sponsors_comp_idx ON competition_sponsors(competition_id, sort_order);
