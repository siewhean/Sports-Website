import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { validateSportPack } from "@matchday/domain";
import { parseSportPackDraftReceipt, phase3AdminMachine } from "@/lib/phase3-sport-pack-admin";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest) {
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, phase3AdminMachine.definitionKeys) ||
    validateSportPack(body.definition).length > 0
  ) {
    return NextResponse.json(
      { error: { code: phase3AdminMachine.requestInvalid, message: phase3AdminMachine.invalidDraft } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: phase3AdminMachine.post,
    path: "/api/v1/admin/sport-packs",
    body,
    validate: (value) => parseSportPackDraftReceipt(value) !== null,
  });
}
