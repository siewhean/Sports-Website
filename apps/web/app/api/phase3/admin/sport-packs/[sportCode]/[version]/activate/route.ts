import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SPORT_PACKS } from "@matchday/domain";
import { parseSportPackActivationReceipt, phase3AdminMachine } from "@/lib/phase3-sport-pack-admin";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sportCode: string; version: string }> },
) {
  const body = await jsonBody(request);
  const { sportCode, version } = await params;
  if (
    !(sportCode in SPORT_PACKS) ||
    !version ||
    !body ||
    !hasExactKeys(body, phase3AdminMachine.activationKeys) ||
    !Number.isSafeInteger(body.revision) ||
    (body.revision as number) < 1 ||
    (body.expected_active_version !== null &&
      (typeof body.expected_active_version !== "string" || !body.expected_active_version))
  ) {
    return NextResponse.json(
      { error: { code: phase3AdminMachine.requestInvalid, message: phase3AdminMachine.invalidActivation } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: phase3AdminMachine.post,
    path: `/api/v1/admin/sport-packs/${encodeURIComponent(sportCode)}/${encodeURIComponent(version)}/activate`,
    body,
    validate: (value) => {
      const receipt = parseSportPackActivationReceipt(value);
      return (
        receipt?.sportCode === sportCode &&
        receipt.version === version &&
        receipt.previousActiveVersion === body.expected_active_version
      );
    },
  });
}
