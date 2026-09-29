import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isOfficialMutationResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateEmptyBody, validationError } from "@/lib/phase4-officials-bff.server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; officialId: string }> },
) {
  const { competitionId, officialId } = await params;
  const raw = await jsonBody(request);
  const validated = validateEmptyBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.post,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials/${encodeURIComponent(officialId)}/archive`,
    validate: isOfficialMutationResponse,
  });
}
