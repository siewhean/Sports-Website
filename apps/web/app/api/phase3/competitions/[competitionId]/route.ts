import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { opaqueId } from "@matchday/ui";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { phase3CommandMachine } from "@/lib/phase3-sport-settings";

const allowedKeys = new Set<string>([
  opaqueId("revision"),
  opaqueId("name"),
  opaqueId("slug"),
  opaqueId("sport_code"),
  opaqueId("venue"),
  opaqueId("address"),
  opaqueId("locality"),
  opaqueId("country_code"),
  opaqueId("starts_on"),
  opaqueId("ends_on"),
  opaqueId("timezone"),
  opaqueId("locale"),
  opaqueId("confirm_pack_switch"),
  opaqueId("confirm_results_affected"),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const body = await jsonBody(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Number.isInteger(body.revision) ||
    (body.revision as number) < 1 ||
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    (body.confirm_pack_switch !== undefined && typeof body.confirm_pack_switch !== "boolean") ||
    (body.confirm_results_affected !== undefined && typeof body.confirm_results_affected !== "boolean")
  ) {
    return NextResponse.json(
      { error: { code: phase3CommandMachine.requestInvalid, message: opaqueId("Invalid competition update payload") } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: "PATCH",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/phase3`,
    body,
    validate: (payload) => Boolean(payload && typeof payload === "object"),
  });
}
