import {
  FeatureFlagEvaluator,
  featureFlags,
  type FeatureFlagReader,
  type FeatureFlagScope,
} from "@matchday/feature-flags";

/** Global flags that a deployment can switch with an environment variable ("true" or "false"). */
const environmentKeys: Partial<Record<keyof typeof featureFlags, string>> = {
  "scoring.phase2-route": "MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE",
  "organiser.redesign-shell": "MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL",
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

export async function isPhase2ScoringRouteEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("scoring.phase2-route")).value;
}

/** Redesign Phase 2 navigation shell. Off unless MATCHDAY_FEATURE_ORGANISER_REDESIGN_SHELL=true. */
export async function isOrganiserRedesignShellEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("organiser.redesign-shell")).value;
}

/** Redesign Phase 4 Rules page (redesign_p4_rules). Off unless MATCHDAY_FEATURE_REDESIGN_P4_RULES=true. */
export async function isRedesignRulesEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("organiser.redesign-p4-rules")).value;
}

export const isOrganiserRedesignP4RulesEnabled = isRedesignRulesEnabled;

/** Redesign Phase 5 format cards (redesign_p5_cards). Off unless MATCHDAY_FEATURE_REDESIGN_P5_CARDS=true. */
export async function isRedesignP5CardsEnabled(): Promise<boolean> {
  return (await evaluator.evaluate("organiser.redesign-p5-cards")).value;
}

export const isOrganiserRedesignP5CardsEnabled = isRedesignP5CardsEnabled;
