import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, isDefaultResponse, jsonBody } from "@/lib/phase3-settings-command.server";
import { phase3CommandMachine } from "@/lib/phase3-sport-settings";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ sportCode: string }> }) {
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, phase3CommandMachine.defaultKeys) ||
    typeof body.pack_version !== "string" ||
    !body.settings ||
    typeof body.settings !== "object" ||
    Array.isArray(body.settings)
  ) {
    return NextResponse.json(
      { error: { code: phase3CommandMachine.requestInvalid, message: phase3CommandMachine.invalidDefault } },
      { status: 400 },
    );
  }
  const { sportCode } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3CommandMachine.put,
    path: `/api/v1/account/sport-defaults/${encodeURIComponent(sportCode)}`,
    body,
    validate: isDefaultResponse,
  });
}
