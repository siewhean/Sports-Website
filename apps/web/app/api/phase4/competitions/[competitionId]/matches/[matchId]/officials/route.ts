import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isMatchOfficialsMutationResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateMatchAssignmentsBody, validationError } from "@/lib/phase4-officials-bff.server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const { competitionId, matchId } = await params;
  const raw = await jsonBody(request);
  const validated = validateMatchAssignmentsBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.put,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/officials`,
    body: validated.body,
    validate: isMatchOfficialsMutationResponse,
  });
}
