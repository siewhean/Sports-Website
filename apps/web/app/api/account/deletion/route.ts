import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { messages } from "@matchday/ui";
import { accountHttp } from "@/lib/account-ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

/** Confirmed PDPA deletion: forwards to the API (CSRF + Origin enforced there) and drops the local session cookie. */
export async function POST(request: NextRequest) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["confirmation"]) || typeof body.confirmation !== "string") {
    return NextResponse.json(
      { error: { code: gateCC4Http.errors.requestInvalid, message: messages.account.deleteFailed } },
      { status: 400 },
    );
  }
  const response = await forwardPhase3Mutation(request, {
    method: gateCC4Http.methodPost,
    path: "/api/v1/account/deletion",
    body: { confirmation: body.confirmation },
    validate: (value) => typeof value === "object" && value !== null,
  });
  if (response.ok) {
    for (const name of accountHttp.sessionCookieNames) response.cookies.delete(name);
    response.headers.set(gateCC4Http.cacheControlHeader, gateCC4Http.cacheNoStore);
  }
  return response;
}
