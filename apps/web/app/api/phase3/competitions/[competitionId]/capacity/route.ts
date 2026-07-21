import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isCapacityMutationBody, parseCapacityResponse, phase3CapacityMachine } from "@/lib/phase3-capacity";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!isCapacityMutationBody(body)) {
    return NextResponse.json(
      { error: { code: phase3CapacityMachine.requestInvalid, message: phase3CapacityMachine.invalidCommand } },
      { status: 400 },
    );
  }
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3CapacityMachine.put,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/capacity`,
    body: body as unknown as Record<string, unknown>,
    validate: (value) => parseCapacityResponse(value, competitionId) !== null,
  });
}
