import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import {
  isCompetitionCreateRequest,
  parseCompetitionOrganisationOptions,
  parseCompetitionCreateReceipt,
  phase3CompetitionCreateMachine,
} from "@/lib/phase3-competition-create";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest) {
  const result = await readPhase3Json(request, phase3CompetitionCreateMachine.optionsPath);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code:
            result.status === 401 || result.status === 403
              ? phase3CompetitionCreateMachine.authRequired
              : phase3CompetitionCreateMachine.apiUnavailable,
          message: phase3CompetitionCreateMachine.optionsUnavailable,
        },
      },
      { status: result.status === 401 || result.status === 403 ? result.status : 503 },
    );
  }
  const options = parseCompetitionOrganisationOptions(result.payload);
  if (!options) {
    return NextResponse.json(
      {
        error: {
          code: phase3CompetitionCreateMachine.organisationResponseInvalid,
          message: phase3CompetitionCreateMachine.optionsUnavailable,
        },
      },
      { status: 502 },
    );
  }
  return NextResponse.json(options);
}

export async function POST(request: NextRequest) {
  const body = await jsonBody(request);
  if (!isCompetitionCreateRequest(body)) {
    return NextResponse.json(
      {
        error: {
          code: phase3CompetitionCreateMachine.validationError,
          message: phase3CompetitionCreateMachine.invalidRequest,
        },
      },
      { status: 400 },
    );
  }

  return forwardPhase3Mutation(request, {
    method: phase3CompetitionCreateMachine.post,
    path: "/api/v1/competitions/phase3",
    body,
    validate: (value) => parseCompetitionCreateReceipt(value)?.sport_code === body.sport_code,
    successStatus: 201,
  });
}
