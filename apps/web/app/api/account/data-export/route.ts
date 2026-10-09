import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { accountHttp } from "@/lib/account-ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

const attachmentDate = () => new Date().toISOString().slice(0, 10);

/** Authenticated PDPA access request: streams the API's account export as a JSON download. */
export async function GET(request: NextRequest) {
  const result = await readPhase3Json(request, "/api/v1/account/data-export");
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: gateCC4Http.errors.authRequired } },
      { status: result.status === 429 ? 429 : result.status === 401 ? 401 : 502 },
    );
  }
  return new NextResponse(JSON.stringify(result.payload, null, 2), {
    headers: {
      "content-type": accountHttp.jsonUtf8ContentType,
      [gateCC4Http.contentDispositionHeader]: `attachment; filename="matchday-account-data-${attachmentDate()}.json"`,
      [gateCC4Http.cacheControlHeader]: gateCC4Http.cacheNoStore,
    },
  });
}
