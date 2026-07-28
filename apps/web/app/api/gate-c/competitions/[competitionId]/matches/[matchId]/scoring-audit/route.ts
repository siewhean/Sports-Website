import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCResultsCopy as copy, gateCResultsMachine as machine, parseMatchScoringAudit } from "@/lib/gate-c-results";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const { competitionId, matchId } = await params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/scoring-audit`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: machine.scoringAuditUnavailable, message: copy.scoringAuditUnavailable } },
      { status: result.status },
    );
  }
  const audit = parseMatchScoringAudit(result.payload);
  return audit
    ? NextResponse.json(result.payload)
    : NextResponse.json(
        { error: { code: machine.scoringAuditInvalid, message: copy.scoringAuditInvalid } },
        { status: 502 },
      );
}
