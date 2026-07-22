import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhoneScoring } from "@/components/phase2/PhoneScoring";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { phase2Copy, phase2Machine } from "@/lib/phase2";
import { isScoringAccessToken } from "@/lib/scoring-access";

export const metadata: Metadata = { title: phase2Copy.scoringAccess, robots: { index: false, follow: false } };
export default async function ScoreTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const demo = demoFixturesEnabled();
  const isDemoRoute = demo && token === "m12-access";
  if (!isDemoRoute && !isScoringAccessToken(token)) notFound();
  return <PhoneScoring mode={demo ? phase2Machine.scoringDemoMode : phase2Machine.scoringApiMode} />;
}
