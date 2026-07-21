import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicCompetition } from "@/components/phase2/PublicCompetition";
import { phase2Copy } from "@/lib/phase2";
import { getCompetitionView } from "@/lib/phase2-public.server";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const competition = await getCompetitionView(slug);
  if (!competition) return {};
  return {
    title: competition.name,
    description: `${competition.sport}. ${phase2Copy.results}, ${phase2Copy.schedule}, ${phase2Copy.table}.`,
    openGraph: { title: competition.name, description: competition.sport, type: "website" },
  };
}

export default async function CompetitionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const competition = await getCompetitionView(slug);
  if (!competition) notFound();
  return <PublicCompetition competition={competition} />;
}
