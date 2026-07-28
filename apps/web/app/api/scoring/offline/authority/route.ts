import { establishOfflineScoringAuthority, revokeOfflineScoringAuthority } from "@/lib/scoring-bff.server";

export async function POST(request: Request): Promise<Response> {
  return establishOfflineScoringAuthority(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return revokeOfflineScoringAuthority(request);
}
