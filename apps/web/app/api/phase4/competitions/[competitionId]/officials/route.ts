import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isOfficialResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateCreateOfficialBody, validationError } from "@/lib/phase4-officials-bff.server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const raw = await jsonBody(request);
  const validated = validateCreateOfficialBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.post,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials`,
    body: validated.body,
    validate: isOfficialResponse,
    successStatus: 201,
  });
}
