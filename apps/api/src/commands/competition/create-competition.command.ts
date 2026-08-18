import type { Command, CommandHandler } from "../types.js";
import type { CompetitionRepository } from "../../repositories/competition.repository.js";
import { ApiError } from "../../errors.js";

export type CreateCompetitionPayload = {
  organisationId: string;
  name: string;
  slug: string;
  sportCode: string;
  sportPackVersion: string;
};

export class CreateCompetitionCommand implements Command<CreateCompetitionPayload> {
  readonly kind = "competition.create";
  constructor(readonly payload: CreateCompetitionPayload) {}
}

export class CreateCompetitionHandler implements CommandHandler<
  CreateCompetitionCommand,
  { id: string; slug: string }
> {
  constructor(private readonly competitionRepo: CompetitionRepository) {}

  async execute(command: CreateCompetitionCommand): Promise<{ id: string; slug: string }> {
    const { slug } = command.payload;
    const exists = await this.competitionRepo.existsBySlug(slug);
    if (exists) {
      throw new ApiError(409, "COMPETITION_SLUG_TAKEN", `Competition slug '${slug}' is already in use`);
    }

    return {
      id: crypto.randomUUID(),
      slug,
    };
  }
}
