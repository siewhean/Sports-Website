import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { forwardPhase3Mutation, jsonBody, readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  const result = await readPhase3Json(request, `/api/v1/notifications/preferences/${encodeURIComponent(type)}`);
  if (!result.ok) return NextResponse.json({}, { status: result.status });
  return NextResponse.json(result.payload, { headers: { [gateCC4Http.cacheControlHeader]: gateCC4Http.cacheNoStore } });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const body = await jsonBody(request);
  if (
    !body ||
    Object.keys(body).length !== 2 ||
    typeof body.in_app_enabled !== "boolean" ||
    typeof body.email_enabled !== "boolean"
  ) {
    return NextResponse.json({}, { status: 400 });
  }
  const { type } = await params;
  return forwardPhase3Mutation(request, {
    method: gateCC4Http.methodPut,
    path: `/api/v1/notifications/preferences/${encodeURIComponent(type)}`,
    body,
    validate: () => true,
  });
}
