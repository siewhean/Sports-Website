import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isAvailabilityMutationResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateAvailabilityBody, validationError } from "@/lib/phase4-officials-bff.server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; officialId: string }> },
) {
  const { competitionId, officialId } = await params;
  const raw = await jsonBody(request);
  const validated = validateAvailabilityBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.put,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials/${encodeURIComponent(officialId)}/availability`,
    body: validated.body,
    validate: isAvailabilityMutationResponse,
  });
}
