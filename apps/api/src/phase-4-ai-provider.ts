import type { AiProviderPort, CompetitionBriefProviderRequest } from "@matchday/ai";
import type { Phase4AiMissingField, Phase4CompetitionBrief } from "@matchday/contracts";

const sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;

function matchInteger(text: string, pattern: RegExp): number | null {
  const value = text.match(pattern)?.[1];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function canonicalSport(text: string): (typeof sports)[number] | null {
  const normalized = text.toLowerCase().replace(/[\s-]+/g, "_");
  return sports.find((sport) => normalized.includes(sport)) ?? null;
}

/**
 * Deterministic local/test provider. It intentionally extracts only explicit
 * facts and leaves everything else missing so it cannot invent competition
 * configuration. Production defaults to the disabled/manual path.
 */
export class DeterministicPhase4AiStub implements AiProviderPort {
  async generateCompetitionBrief(request: CompetitionBriefProviderRequest) {
    const text = request.organiserText.normalize("NFC");
    const entryCount = matchInteger(text, /\b(\d{1,2})\s+(?:entries|teams|players)\b/i);
    const divisionCount = matchInteger(text, /\b(\d{1,2})\s+divisions?\b/i);
    const playingAreas = matchInteger(text, /\b(\d{1,2})\s+(?:courts|pitches|fields|playing areas?)\b/i);
    const slotMinutes = matchInteger(text, /\b(\d{1,3})\s*(?:minute|min)\s+(?:slots?|matches?)\b/i);
    const minimumMatches = matchInteger(text, /\b(?:minimum|min(?:imum)? of)\s*(\d{1,2})\s+matches?\b/i);
    const dates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1]!);
    const sport = canonicalSport(text);
    const missing: Phase4AiMissingField[] = [];
    if (!sport) missing.push("sport");
    if (!entryCount) missing.push("entry_count");
    if (!divisionCount) missing.push("division_count", "divisions");
    if (!/\b(?:at|venue)\s+[^,.]+/i.test(text)) missing.push("location");
    if (!dates[0]) missing.push("dates.start");
    if (!dates[1]) missing.push("dates.end");
    if (!playingAreas) missing.push("playing_areas");
    missing.push("daily_availability");
    if (!slotMinutes) missing.push("time_slot_minutes");
    if (!minimumMatches) missing.push("minimum_matches_per_entry");
    missing.push(
      "knockout_required",
      "rank_all_entries",
      "placement_required",
      "cross_group_qualification_allowed",
      "organiser_priority",
    );
    const venue = text.match(/\b(?:at|venue)\s+([^,.]+)/i)?.[1]?.trim() ?? null;
    const brief: Phase4CompetitionBrief = {
      schema_version: "1.0",
      name: text.match(/\b(?:called|named)\s+["']?([^"',.]+)/i)?.[1]?.trim() ?? null,
      sport,
      entry_count: entryCount,
      division_count: divisionCount,
      divisions: null,
      location: venue ? { venue, address: null, locality: null, country_code: null } : null,
      dates: { start: dates[0] ?? null, end: dates[1] ?? null },
      playing_areas: playingAreas,
      daily_availability: null,
      time_slot_minutes: slotMinutes,
      minimum_matches_per_entry: minimumMatches,
      knockout_required: null,
      rank_all_entries: null,
      placement_required: null,
      cross_group_qualification_allowed: null,
      organiser_priority: null,
      missing_fields: [...new Set(missing)],
    };
    return { data: brief, providerRequestId: "phase4-deterministic-stub-v1" };
  }
}

export type Phase4AiProviderMode = "disabled" | "stub";

export function phase4AiProviderFromEnvironment(
  environment: string,
  source: NodeJS.ProcessEnv = process.env,
): { mode: Phase4AiProviderMode; provider: AiProviderPort | null; timeoutMs: number; maximumAttempts: number; cacheTtlSeconds: number } {
  const mode = source.PHASE4_AI_PROVIDER ?? "disabled";
  if (mode !== "disabled" && mode !== "stub") throw new Error("PHASE4_AI_PROVIDER must be disabled or stub");
  if (mode === "stub" && environment !== "local" && environment !== "test") {
    throw new Error("PHASE4_AI_PROVIDER=stub is permitted only in local/test");
  }
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const raw = source[key];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
  };
  return {
    mode,
    provider: mode === "stub" ? new DeterministicPhase4AiStub() : null,
    timeoutMs: integer("PHASE4_AI_TIMEOUT_MS", 8_000, 1, 60_000),
    maximumAttempts: integer("PHASE4_AI_MAX_ATTEMPTS", 3, 1, 3),
    cacheTtlSeconds: integer("PHASE4_AI_CACHE_TTL_SECONDS", 86_400, 60, 2_592_000),
  };
}
