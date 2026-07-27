import type { NextRequest } from "next/server";
import { gateCAccessMachine, parseRevokedPass } from "@/lib/gate-c-access";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; passId: string }> },
) {
  const body = await jsonBody(request);
  const reason = body && typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const { competitionId, passId } = await params;
  return forwardPhase3Mutation(request, {
    method: gateCAccessMachine.delete,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/access-passes/${encodeURIComponent(passId)}`,
    ...(reason ? { body: { reason } } : {}),
    validate: (value) => parseRevokedPass(value) !== null,
  });
}
