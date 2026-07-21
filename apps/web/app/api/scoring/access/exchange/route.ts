import { exchangeScoringSession } from "@/lib/scoring-bff.server";

export async function POST(request: Request): Promise<Response> {
  return exchangeScoringSession(request);
}
