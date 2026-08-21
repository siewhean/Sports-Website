import type { NextRequest } from "next/server";
import { forwardGateCC4BinaryMutation } from "@/lib/gate-c-c4-command.server";

export async function POST(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const path = `/api/v1/competitions/${encodeURIComponent(competitionId)}/exports/schedule`;
  return forwardGateCC4BinaryMutation(request, path);
}
