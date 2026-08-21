import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { parseGateCC4References } from "@/lib/gate-c-c4-references";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(request, `/api/v1/competitions/${encodeURIComponent(competitionId)}`);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code: result.status === 401 ? gateCC4Http.errors.authRequired : gateCC4Http.errors.referenceReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const scheduleWorkspace = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/schedule-workspace`,
  );
  if (!scheduleWorkspace.ok) {
    return NextResponse.json(
      {
        error: {
          code:
            scheduleWorkspace.status === 401 ? gateCC4Http.errors.authRequired : gateCC4Http.errors.referenceReadFailed,
        },
      },
      { status: scheduleWorkspace.status },
    );
  }
  const schedule = scheduleWorkspace.payload;
  const matches = record(schedule) && Array.isArray(schedule.matches) ? schedule.matches : null;
  const references = parseGateCC4References(record(result.payload) ? { ...result.payload, matches } : result.payload);
  return references
    ? NextResponse.json(references, {
        headers: { "cache-control": gateCC4Http.cacheNoStore },
      })
    : NextResponse.json({ error: { code: gateCC4Http.errors.referenceResponseInvalid } }, { status: 502 });
}
