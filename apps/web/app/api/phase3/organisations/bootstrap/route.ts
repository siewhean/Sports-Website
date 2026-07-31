import type { NextRequest } from "next/server";
import { forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import {
  parseCompetitionOrganisationBootstrapReceipt,
  phase3CompetitionCreateMachine,
} from "@/lib/phase3-competition-create";

export async function POST(request: NextRequest) {
  return forwardPhase3Mutation(request, {
    method: phase3CompetitionCreateMachine.post,
    path: phase3CompetitionCreateMachine.bootstrapPath,
    validate: (value) => parseCompetitionOrganisationBootstrapReceipt(value) !== null,
  });
}
