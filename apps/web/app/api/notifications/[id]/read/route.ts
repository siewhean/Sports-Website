import type { NextRequest } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardPhase3Mutation(request, {
    method: gateCC4Http.methodPost,
    path: `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    body: {},
    validate: () => true,
  });
}
