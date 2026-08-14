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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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

  const response = await forwardPhase3Mutation(request, {
    method: phase3CompetitionCreateMachine.post,
    path: "/api/v1/competitions/phase3",
    body,
    validate: (value) => parseCompetitionCreateReceipt(value)?.sport_code === body.sport_code,
    successStatus: 201,
  });

  if (response.status !== 500) return response;
  const payload: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const upstreamError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  if (upstreamError?.code !== "INTERNAL_ERROR") return response;

  return NextResponse.json(
    {
      error: {
        code: "COMPETITION_CREATE_FAILED",
        message:
          "Competition could not be created. The competition URL may already be in use. Try a different URL and submit again.",
        ...(typeof upstreamError.request_id === "string" ? { request_id: upstreamError.request_id } : {}),
      },
    },
    { status: 500 },
  );
}
