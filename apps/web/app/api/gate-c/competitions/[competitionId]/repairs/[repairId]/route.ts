import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseGateCC4Workspace } from "@/lib/gate-c-c4";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string; repairId: string }> },
) {
  const { competitionId, repairId } = await context.params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(repairId)}`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.status === 401 ? "AUTH_REQUIRED" : "REPAIR_READ_FAILED" } },
      { status: result.status },
    );
  }
  const workspace = parseGateCC4Workspace(result.payload);
  return workspace
    ? NextResponse.json(workspace, { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: { code: "REPAIR_RESPONSE_INVALID" } }, { status: 502 });
}
