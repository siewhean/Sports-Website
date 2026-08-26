import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest) {
  const result = await readPhase3Json(request, `/api/v1/notifications`);
  if (!result.ok) {
    return NextResponse.json(
      { items: [], unreadCount: 0 },
      { headers: { [gateCC4Http.cacheControlHeader]: gateCC4Http.cacheNoStore } },
    );
  }
  return NextResponse.json(result.payload, {
    headers: { [gateCC4Http.cacheControlHeader]: gateCC4Http.cacheNoStore },
  });
}
