import { recoverScoringSession } from "@/lib/scoring-bff.server";

export async function GET(request: Request): Promise<Response> {
  return recoverScoringSession(request);
}
