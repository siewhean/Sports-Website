import type { NextRequest } from "next/server";
import { forwardWorkspaceGet } from "@/lib/phase4-officials-bff.server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  return forwardWorkspaceGet(request, competitionId);
}
