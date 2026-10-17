import type { FeatureFlagDefinition } from "./types.js";

const booleanFlag = (defaultValue: boolean, description: string): FeatureFlagDefinition<boolean> => ({
  defaultValue,
  description,
  isValid: (value): value is boolean => typeof value === "boolean",
});

export const featureFlags = {
  "maintenance.global": booleanFlag(false, "Show the global maintenance experience and suspend new operational work."),
  "registration.self-service": booleanFlag(false, "Allow public self-service competition registration."),
  "scoring.unknown-scorer": booleanFlag(
    false,
    "Allow goals with an unknown scorer when explicitly enabled for a competition.",
  ),
  "scoring.phase2-route": booleanFlag(
    true,
    "Serve the Phase 2 scoring experience at the canonical score route instead of the Phase 0 prototype.",
  ),
  "public.results": booleanFlag(true, "Expose published competition results on public surfaces."),
  "organiser.redesign-shell": booleanFlag(
    false,
    "Redesign Phase 2: organiser competition pages use the Setup / Live navigation shell and account menu.",
  ),
  "organiser.redesign-p3-start": booleanFlag(
    false,
    "Redesign Phase 3: guided competition start with 3-question creation, division short codes, and setup checklist.",
  ),
} as const;

export type MatchdayFeatureFlags = typeof featureFlags;
