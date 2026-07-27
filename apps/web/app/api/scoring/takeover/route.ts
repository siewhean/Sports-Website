import { requestScoringTakeover } from "@/lib/scoring-bff.server";

export async function POST(request: Request) {
  return requestScoringTakeover(request);
}
