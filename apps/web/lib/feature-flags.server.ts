import {
  FeatureFlagEvaluator,
  featureFlags,
  type FeatureFlagReader,
  type FeatureFlagScope,
} from "@matchday/feature-flags";

const phase2RouteEnvironmentKey = "MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE";

const environmentFlagReader: FeatureFlagReader = {
  async getOverride(flagKey: string, scope: FeatureFlagScope): Promise<unknown | undefined> {
    if (flagKey !== "scoring.phase2-route" || scope.kind !== "global") return undefined;

    const configuredValue = process.env[phase2RouteEnvironmentKey]?.trim().toLowerCase();
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
