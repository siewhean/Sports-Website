import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { parseGateCC4PendingRepairCases } from "@/lib/gate-c-c4-pending";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/pending`,
  );
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code: result.status === 401 ? gateCC4Http.errors.authRequired : gateCC4Http.errors.repairIntakeReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const pending = parseGateCC4PendingRepairCases(result.payload);
  return pending
    ? NextResponse.json(pending, {
        headers: { "cache-control": gateCC4Http.cacheNoStore },
      })
    : NextResponse.json({ error: { code: gateCC4Http.errors.repairIntakeResponseInvalid } }, { status: 502 });
}
