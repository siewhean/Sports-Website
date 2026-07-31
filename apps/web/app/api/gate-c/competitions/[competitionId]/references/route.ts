import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseGateCC4References } from "@/lib/gate-c-c4-references";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string }> },
) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.status === 401 ? "AUTH_REQUIRED" : "REFERENCE_READ_FAILED" } },
      { status: result.status },
    );
  }
  const references = parseGateCC4References(result.payload);
  return references
    ? NextResponse.json(references, { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: { code: "REFERENCE_RESPONSE_INVALID" } }, { status: 502 });
}
