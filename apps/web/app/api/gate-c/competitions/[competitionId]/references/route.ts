import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { parseGateCC4References } from "@/lib/gate-c-c4-references";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(request, `/api/v1/competitions/${encodeURIComponent(competitionId)}`);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code:
            result.status === 401
              ? gateCC4Http.errors.authRequired
              : gateCC4Http.errors.referenceReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const references = parseGateCC4References(result.payload);
  return references
    ? NextResponse.json(references, {
        headers: { "cache-control": gateCC4Http.cacheNoStore },
      })
    : NextResponse.json(
        { error: { code: gateCC4Http.errors.referenceResponseInvalid } },
        { status: 502 },
      );
}
