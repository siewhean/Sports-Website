import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseGateCC4Workspace } from "@/lib/gate-c-c4";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
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
      {
        error: {
          code: result.status === 401 ? gateCC4Http.errors.authRequired : gateCC4Http.errors.repairReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const workspace = parseGateCC4Workspace(result.payload);
  return workspace
    ? NextResponse.json(workspace, {
        headers: { "cache-control": gateCC4Http.cacheNoStore },
      })
    : NextResponse.json({ error: { code: gateCC4Http.errors.repairResponseInvalid } }, { status: 502 });
}
