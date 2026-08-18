import { ApiError, ErrorCode } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import { ReliableGateBPhase4Runtime } from "./phase-4-reliable-runtime.js";

const v1DefaultFormatPreferences = {
  minimum_matches: { per_entry: 1 },
  ranking: { rank_all_entries: false },
  knockout: { required: true },
  placement: { required: false },
  qualification: { cross_group_allowed: true },
  priority: { value: "speed" as const },
} as const;

/**
 * V1 organiser policy layered on top of the full Phase 4 runtime.
 *
 * The simple Format page should depend only on organiser-owned Entries and
 * Capacity. The full Assisted Setup wizard has a separate format-preferences
 * step, but requiring that hidden step here makes the direct V1 journey appear
 * broken. Seed the intentionally narrow V1 preferences only when the organiser
 * has completed the real prerequisites and has not already saved preferences.
 */
export class V1Phase4Runtime extends ReliableGateBPhase4Runtime {
  override async recommendV1Format(
    actor: Phase3Actor,
    competitionId: string,
    idempotencyKey: string,
    requestId: string,
  ) {
    try {
      return await super.recommendV1Format(actor, competitionId, idempotencyKey, requestId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "FORMAT_PREREQUISITE_MISSING") throw error;

      const source = await this.readSetupDraft(actor, competitionId);
      if (!source.values.capacity || !source.values.entries || source.values.format_preferences) throw error;

      const preferenceKey = `${idempotencyKey.slice(0, 150)}:v1-defaults`;
      const saved = await this.autosaveSetupDraft(
        actor,
        competitionId,
        {
          expected_revision: source.revision,
          idempotency_key: preferenceKey,
          transition: {
            kind: "save_step",
            step: { step_id: "format_preferences", value: v1DefaultFormatPreferences },
          },
        },
        requestId,
      );

      if (saved.outcome !== "saved" && saved.outcome !== "idempotent_replay") {
        throw new ApiError(
          409,
          ErrorCode.FORMAT_RECOMMENDATION_CONFLICT,
          "The competition changed; refresh the format page",
        );
      }

      return super.recommendV1Format(actor, competitionId, `${idempotencyKey.slice(0, 150)}:v1-retry`, requestId);
    }
  }
}
