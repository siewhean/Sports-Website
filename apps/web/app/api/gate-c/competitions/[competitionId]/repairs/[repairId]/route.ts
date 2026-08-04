import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4BffMachine } from "@/lib/gate-c-c4-bff";
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
      {
        error: {
          code:
            result.status === 401 ? gateCC4BffMachine.errors.authRequired : gateCC4BffMachine.errors.repairReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const workspace = parseGateCC4Workspace(result.payload);
  return workspace
    ? NextResponse.json(workspace, {
        headers: { [gateCC4BffMachine.headers.cacheControl]: gateCC4BffMachine.cache.noStore },
      })
    : NextResponse.json({ error: { code: gateCC4BffMachine.errors.repairResponseInvalid } }, { status: 502 });
}
