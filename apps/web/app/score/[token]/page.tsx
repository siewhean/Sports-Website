import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhoneScoring } from "@/components/phase2/PhoneScoring";
import { phase2Copy, phase2Machine } from "@/lib/phase2";
import { isScoringAccessToken } from "@/lib/scoring-access";

export const metadata: Metadata = { title: phase2Copy.scoringAccess, robots: { index: false, follow: false } };
export default async function ScoreTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const isDemoRoute = process.env.MATCHDAY_PHASE2_DATA_MODE === phase2Machine.scoringDemoMode && token === "m12-access";
  if (!isDemoRoute && !isScoringAccessToken(token)) notFound();
  return (
    <PhoneScoring
      mode={
        process.env.MATCHDAY_PHASE2_DATA_MODE === phase2Machine.scoringDemoMode
          ? phase2Machine.scoringDemoMode
          : phase2Machine.scoringApiMode
      }
    />
  );
}
