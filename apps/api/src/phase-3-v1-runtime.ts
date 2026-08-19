import { ApiError, ErrorCode } from "./errors.js";
import { Phase3Runtime, type Phase3Actor, type Phase3CompetitionCreateInput } from "./phase-3-runtime.js";

type PostgresErrorLike = Readonly<{
  code?: unknown;
  constraint_name?: unknown;
  constraint?: unknown;
  detail?: unknown;
  message?: unknown;
}>;

function postgresError(error: unknown): PostgresErrorLike | null {
  return error !== null && typeof error === "object" ? (error as PostgresErrorLike) : null;
}

export function isCompetitionSlugConflict(error: unknown): boolean {
  const candidate = postgresError(error);
  if (!candidate || candidate.code !== "23505") return false;

  const constraint =
    typeof candidate.constraint_name === "string"
      ? candidate.constraint_name
      : typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  if (constraint === "competitions_slug_key") return true;

  const detail = typeof candidate.detail === "string" ? candidate.detail : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /competitions_slug_key|Key \(slug\)=/i.test(`${detail} ${message}`);
}

/**
 * V1-facing Phase 3 runtime policy.
 *
 * The canonical runtime intentionally lets unexpected persistence failures bubble
 * to the API error boundary. For the simple V1 organiser journey, a duplicate
 * competition slug is not unexpected: organisers can reasonably reuse a name or
 * URL while testing. Translate that single database constraint into a normal
 * conflict without weakening the globally unique public URL invariant.
 */
export class V1Phase3Runtime extends Phase3Runtime {
  override async createCompetition(
    actor: Phase3Actor,
    input: Phase3CompetitionCreateInput,
    requestId: string,
    idempotencyKey = requestId,
  ) {
    try {
      return await super.createCompetition(actor, input, requestId, idempotencyKey);
    } catch (error) {
      if (isCompetitionSlugConflict(error)) {
        throw new ApiError(
          409,
          ErrorCode.COMPETITION_SLUG_TAKEN,
          "That competition URL is already in use. Choose a different URL and try again.",
        );
      }
      throw error;
    }
  }
}
