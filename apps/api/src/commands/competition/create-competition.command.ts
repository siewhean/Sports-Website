import type { Command, CommandHandler } from "../types.js";
import type { CompetitionRepository } from "../../repositories/competition.repository.js";
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

  async execute(command: CreateCompetitionCommand): Promise<{ id: string; slug: string; revision: number }> {
    const { payload } = command;
    const exists = await this.competitionRepo.existsBySlug(payload.slug);
    if (exists) {
      throw new ApiError(409, ErrorCode.COMPETITION_SLUG_TAKEN, `Competition slug '${payload.slug}' is already in use`);
    }

    const competitionId = payload.id ?? crypto.randomUUID();
    const result = await this.competitionRepo.create({
      id: competitionId,
      organisationId: payload.organisationId,
      createdBy: payload.createdBy,
      name: payload.name,
      slug: payload.slug,
      sportCode: payload.sportCode,
      venue: payload.venue ?? "",
      address: payload.address ?? "",
      locality: payload.locality ?? null,
      countryCode: payload.countryCode ?? "SG",
      startsOn: payload.startsOn ?? new Date().toISOString().slice(0, 10),
      endsOn: payload.endsOn ?? new Date().toISOString().slice(0, 10),
      timezone: payload.timezone ?? "Asia/Singapore",
      locale: payload.locale ?? "en-SG",
      status: payload.status ?? "draft",
    });

    return {
      id: result.id,
      slug: payload.slug,
      revision: result.revision,
    };
  }
}
