import { heartbeatScoringSession } from "@/lib/scoring-bff.server";

export async function POST(request: Request) {
  return heartbeatScoringSession(request);
}
