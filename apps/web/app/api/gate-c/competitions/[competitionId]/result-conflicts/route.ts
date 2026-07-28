import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCResultsCopy as copy, gateCResultsMachine as machine, parseResultConflicts } from "@/lib/gate-c-results";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/result-conflicts?status=open`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: machine.conflictsUnavailable, message: copy.conflictsUnavailable } },
      { status: result.status },
    );
  }
  const conflicts = parseResultConflicts(result.payload);
  return conflicts
    ? NextResponse.json(result.payload)
    : NextResponse.json({ error: { code: machine.conflictsInvalid, message: copy.conflictsInvalid } }, { status: 502 });
}
