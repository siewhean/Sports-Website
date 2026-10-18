import {
  FeatureFlagEvaluator,
  featureFlags,
  type FeatureFlagReader,
  type FeatureFlagScope,
} from "@matchday/feature-flags";

/** Global flags a deployment can switch with an environment variable ("true" or "false"), as in the web app. */
const environmentKeys: Partial<Record<keyof typeof featureFlags, string>> = {
  "organiser.redesign-p4-rules": "MATCHDAY_FEATURE_REDESIGN_P4_RULES",
  "organiser.redesign-p5-cards": "MATCHDAY_FEATURE_REDESIGN_P5_CARDS",
};

const environmentFlagReader: FeatureFlagReader = {
  async getOverride(flagKey: string, scope: FeatureFlagScope): Promise<unknown | undefined> {
    const environmentKey = environmentKeys[flagKey as keyof typeof featureFlags];
    if (environmentKey === undefined || scope.kind !== "global") return undefined;
    const configuredValue = process.env[environmentKey]?.trim().toLowerCase();
    if (configuredValue === undefined || configuredValue === "") return undefined;
    if (configuredValue === "true") return true;
    if (configuredValue === "false") return false;
    // Return the invalid override so the typed evaluator records and ignores it.
    return configuredValue;
  },
};

const evaluator = new FeatureFlagEvaluator({ registry: featureFlags, storage: environmentFlagReader });

/**
 * Redesign Phase 4 (`redesign_p4_rules`): new competitions start from the federation sport packs. Off unless
 * MATCHDAY_FEATURE_REDESIGN_P4_RULES=true; existing competitions keep their pack whatever the flag says.
 */
export async function isRedesignRulesEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("organiser.redesign-p4-rules")).value;
}

/**
 * Redesign Phase 5 (`redesign_p5_cards`): format selection uses 3-card recommendation view.
 * Off unless MATCHDAY_FEATURE_REDESIGN_P5_CARDS=true.
 */
export async function isRedesignP5CardsEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("organiser.redesign-p5-cards")).value;
}

export const isOrganiserRedesignP5CardsEnabled = isRedesignP5CardsEnabled;
