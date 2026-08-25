export type SubscriptionTier = "free" | "event_pass" | "organiser_pro";

export type EntitlementFeature =
  "unlimited_entries" | "custom_branding" | "sponsor_placements" | "export_advanced" | "ai_actions";

export type OrganisationBillingSummary = {
  organisation_id: string;
  tier: SubscriptionTier;
  status: "active" | "past_due" | "canceled" | "trialing";
  period_start: string;
  period_end: string | null;
  features: EntitlementFeature[];
  ai_quota: {
    limit: number;
    used: number;
    remaining: number;
  };
  custom_branding_allowed: boolean;
  unlimited_entries_allowed: boolean;
  sponsor_placements_allowed: boolean;
};

export type BillingSummary = {
  organisation_id: string;
  tier: SubscriptionTier;
  status: "active" | "past_due" | "cancelled" | "trialing";
  features: EntitlementFeature[];
  custom_branding_allowed: boolean;
  sponsor_placements_allowed: boolean;
  max_entries_per_division: number;
  ai_quota: {
    limit: number;
    used: number;
    remaining: number;
    period_start: string;
    period_end: string | null;
  };
};

export type BillingHistoryItem = {
  id: string;
  event_type: string;
  amount_cents: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  description: string;
  created_at: string;
};

export type CompetitionBranding = {
  competition_id: string;
  primary_color: string | null;
  secondary_color: string | null;
  logo_url: string | null;
  banner_url: string | null;
  hide_platform_badge: boolean;
};

export type CompetitionSponsor = {
  id: string;
  competition_id: string;
  name: string;
  tier: "headline" | "tier1" | "tier2" | "community";
  logo_url: string | null;
  website_url: string | null;
  sort_order: number;
};

export type BillingWebhookPayload = {
  id: string;
  type: string;
  data: {
    object: {
      customer?: string;
      subscription?: string;
      organisation_id?: string;
      tier?: SubscriptionTier;
      top_up_units?: number;
      amount_total?: number;
      currency?: string;
    };
  };
};
