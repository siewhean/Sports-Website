import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isOfficialResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateUpdateOfficialBody, validationError } from "@/lib/phase4-officials-bff.server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; officialId: string }> },
) {
  const { competitionId, officialId } = await params;
  const raw = await jsonBody(request);
  const validated = validateUpdateOfficialBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.patch,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials/${encodeURIComponent(officialId)}`,
    body: validated.body,
    validate: isOfficialResponse,
  });
}
