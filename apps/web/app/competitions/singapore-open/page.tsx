import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicCompetition } from "@/components/phase2/PublicCompetition";
import { phase2Copy, phase2Machine } from "@/lib/phase2";
import { getCompetitionView } from "@/lib/phase2-public.server";

export async function generateMetadata(): Promise<Metadata> {
  const competition = await getCompetitionView(phase2Machine.singaporeOpenSlug);
  if (!competition) return {};
  return {
    title: competition.name,
    description: `${competition.sport}. ${phase2Copy.results}, ${phase2Copy.schedule}, ${phase2Copy.table}.`,
    openGraph: { title: competition.name, description: competition.sport, type: "website" },
  };
}

export default async function PublicCompetitionPage() {
  const competition = await getCompetitionView(phase2Machine.singaporeOpenSlug);
  if (!competition) notFound();
  return <PublicCompetition competition={competition} />;
}
