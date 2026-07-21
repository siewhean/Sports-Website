import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  forwardPhase3Mutation,
  hasExactKeys,
  isSettingsMutationResponse,
  jsonBody,
} from "@/lib/phase3-settings-command.server";
import { phase3CommandMachine } from "@/lib/phase3-sport-settings";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, phase3CommandMachine.settingsKeys) ||
    typeof body.pack_version !== "string" ||
    body.pack_version.length === 0 ||
    !Number.isInteger(body.revision) ||
    (body.revision as number) < 1 ||
    !body.override ||
    typeof body.override !== "object" ||
    Array.isArray(body.override)
  ) {
    return NextResponse.json(
      { error: { code: phase3CommandMachine.requestInvalid, message: phase3CommandMachine.invalidSettings } },
      { status: 400 },
    );
  }
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3CommandMachine.put,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/settings`,
    body,
    validate: isSettingsMutationResponse,
  });
}
