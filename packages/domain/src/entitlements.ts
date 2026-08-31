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

export type TierDefinition = {
  tier: SubscriptionTier;
  label: string;
  maxEntriesPerDivision: number;
  max_entries_per_division: number;
  monthly_ai_actions: number;
  customBrandingAllowed: boolean;
  unlimitedEntriesAllowed: boolean;
  sponsorPlacementsAllowed: boolean;
  advancedExportAllowed: boolean;
  monthlyAiQuota: number;
  features: EntitlementFeature[];
};

export const TIER_DEFINITIONS: Record<SubscriptionTier, TierDefinition> = {
  free: {
    tier: "free",
    label: "Free Starter",
    maxEntriesPerDivision: 16,
    max_entries_per_division: 16,
    monthly_ai_actions: 5,
    customBrandingAllowed: false,
    unlimitedEntriesAllowed: false,
    sponsorPlacementsAllowed: false,
    advancedExportAllowed: false,
    monthlyAiQuota: 5,
    features: ["ai_actions"],
  },
  event_pass: {
    tier: "event_pass",
    label: "Single Event Pass",
    maxEntriesPerDivision: Number.POSITIVE_INFINITY,
    max_entries_per_division: Number.POSITIVE_INFINITY,
    monthly_ai_actions: 25,
    customBrandingAllowed: true,
    unlimitedEntriesAllowed: true,
    sponsorPlacementsAllowed: true,
    advancedExportAllowed: true,
    monthlyAiQuota: 25,
    features: ["unlimited_entries", "custom_branding", "sponsor_placements", "export_advanced", "ai_actions"],
  },
  organiser_pro: {
    tier: "organiser_pro",
    label: "Organiser Pro",
    maxEntriesPerDivision: Number.POSITIVE_INFINITY,
    max_entries_per_division: Number.POSITIVE_INFINITY,
    monthly_ai_actions: 100,
    customBrandingAllowed: true,
    unlimitedEntriesAllowed: true,
    sponsorPlacementsAllowed: true,
    advancedExportAllowed: true,
    monthlyAiQuota: 100,
    features: ["unlimited_entries", "custom_branding", "sponsor_placements", "export_advanced", "ai_actions"],
  },
};

export const TIER_FEATURE_LIMITS = TIER_DEFINITIONS;

export function getTierDefinition(tier: SubscriptionTier = "free"): TierDefinition {
  return TIER_DEFINITIONS[tier] || TIER_DEFINITIONS["free"];
}

export function isFeatureAllowed(tier: SubscriptionTier, feature: EntitlementFeature): boolean {
  const definition = getTierDefinition(tier);
  return definition.features.includes(feature);
}

export function assertFeatureEntitled(tier: SubscriptionTier, feature: EntitlementFeature): void {
  if (!isFeatureAllowed(tier, feature)) {
    throw new Error(`Feature '${feature}' is not included in the ${getTierDefinition(tier).label} tier`);
  }
}

export function getEntitlementAllowance(tier: SubscriptionTier) {
  return getTierDefinition(tier);
}

export function assertEntryLimit(tier: SubscriptionTier, entryCount: number): { allowed: boolean; limit: number } {
  const definition = getTierDefinition(tier);
  const limit = definition.maxEntriesPerDivision;
  if (entryCount > limit) {
    throw new Error(
      `Tier '${definition.label}' allows maximum ${limit} entries per division, but ${entryCount} were requested`,
    );
  }
  return {
    allowed: true,
    limit,
  };
}

export function resolveBillingSummary(input: {
  organisationId: string;
  tier: SubscriptionTier;
  status?: "active" | "past_due" | "canceled" | "trialing";
  periodStart?: string;
  periodEnd?: string | null;
  usedAiUnits: number;
  topUpAiUnits?: number;
}): OrganisationBillingSummary {
  const tier = input.tier ?? "free";
  const definition = getTierDefinition(tier);
  const totalAiLimit = definition.monthlyAiQuota + (input.topUpAiUnits ?? 0);
  const used = Math.max(0, input.usedAiUnits ?? 0);
  const remaining = Math.max(0, totalAiLimit - used);

  return {
    organisation_id: input.organisationId,
    tier,
    status: input.status ?? "active",
    period_start: input.periodStart ?? new Date().toISOString(),
    period_end: input.periodEnd ?? null,
    features: definition.features,
    ai_quota: {
      limit: totalAiLimit,
      used,
      remaining,
    },
    custom_branding_allowed: definition.customBrandingAllowed,
    unlimited_entries_allowed: definition.unlimitedEntriesAllowed,
    sponsor_placements_allowed: definition.sponsorPlacementsAllowed,
  };
}
