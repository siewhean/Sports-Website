import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCAccessMachine, parseTakeoverRequests } from "@/lib/gate-c-access";
import { phase2Copy } from "@/lib/phase2";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/takeover-requests`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.takeoverListUnavailable, message: phase2Copy.serviceUnavailable } },
      { status: result.status },
    );
  }
  const requests = parseTakeoverRequests(result.payload);
  if (!requests) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.takeoverResponseInvalid, message: phase2Copy.serviceUnavailable } },
      { status: 502 },
    );
  }
  return NextResponse.json({
    takeover_requests: requests.map((item) => ({
      id: item.id,
      match_id: item.matchId,
      status: item.status,
      requester_pending_event_count: item.requesterPendingEventCount,
      incumbent_pending_state: item.incumbentPendingState,
      requested_at: item.requestedAt,
      requesting_device_label: item.requestingDeviceLabel,
      incumbent_device_label: item.incumbentDeviceLabel,
    })),
  });
}
