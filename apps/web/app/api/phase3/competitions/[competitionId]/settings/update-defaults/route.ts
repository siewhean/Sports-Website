import type { NextRequest } from "next/server";
import { opaqueId } from "@matchday/ui";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { phase3CommandMachine } from "@/lib/phase3-sport-settings";

const allowedKeys = new Set<string>([opaqueId("confirm_published"), opaqueId("confirm_results_affected")]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const body = await jsonBody(request);
  return forwardPhase3Mutation(request, {
    method: phase3CommandMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/settings/update-defaults`,
    body: body ?? undefined,
    validate: (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const body = payload as Record<string, unknown>;
      return Object.keys(body).every(
        (k) => allowedKeys.has(k) && (body[k] === undefined || typeof body[k] === "boolean"),
      );
    },
  });
}
