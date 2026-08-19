import type { Command, CommandHandler } from "../types.js";
import type { CompetitionRepository } from "../../repositories/competition.repository.js";
import type { SqlExecutor } from "../../repositories/types.js";
import { ApiError, ErrorCode } from "../../errors.js";

export type CreateCompetitionPayload = {
  id?: string;
  organisationId: string;
  createdBy: string;
  name: string;
  slug: string;
  sportCode: string;
  venue?: string;
  address?: string;
  locality?: string | null;
  countryCode?: string;
  startsOn?: string;
  endsOn?: string;
  timezone?: string;
  locale?: string;
  status?: string;
};

export class CreateCompetitionCommand implements Command<CreateCompetitionPayload> {
  readonly kind = "competition.create";
  constructor(readonly payload: CreateCompetitionPayload) {}
}

export class CreateCompetitionHandler implements CommandHandler<
  CreateCompetitionCommand,
  { id: string; slug: string; revision: number }
> {
  constructor(private readonly competitionRepo: CompetitionRepository) {}

  async execute(
    command: CreateCompetitionCommand,
    executor?: SqlExecutor,
  ): Promise<{ id: string; slug: string; revision: number }> {
    const { payload } = command;
    const cleanName = payload.name.trim();
    const cleanSlug = payload.slug.trim().toLowerCase();

    if (executor) {
      await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `competition-slug:${payload.organisationId}:${cleanSlug}`,
      ]);
    }

    const exists = await this.competitionRepo.existsBySlug(cleanSlug, undefined, executor);
    if (exists) {
      throw new ApiError(409, ErrorCode.COMPETITION_SLUG_TAKEN, `Competition slug '${cleanSlug}' is already in use`);
    }

    const competitionId = payload.id ?? crypto.randomUUID();
    const result = await this.competitionRepo.create(
      {
        id: competitionId,
        organisationId: payload.organisationId,
        createdBy: payload.createdBy,
        name: cleanName,
        slug: cleanSlug,
        sportCode: payload.sportCode,
        venue: payload.venue?.trim() ?? "",
        address: payload.address?.trim() ?? "",
        locality: payload.locality?.trim() || null,
        countryCode: payload.countryCode ?? "SG",
        startsOn: payload.startsOn ?? new Date().toISOString().slice(0, 10),
        endsOn: payload.endsOn ?? new Date().toISOString().slice(0, 10),
        timezone: payload.timezone ?? "Asia/Singapore",
        locale: payload.locale ?? "en-SG",
        status: payload.status ?? "draft",
      },
      executor,
    );

    return {
      id: result.id,
      slug: cleanSlug,
      revision: result.revision,
    };
  }
}
