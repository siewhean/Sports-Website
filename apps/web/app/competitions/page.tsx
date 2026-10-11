import type { Metadata } from "next";
import { messages } from "@matchday/ui";
import { PublicCompetitionsList } from "@/components/phase2/PublicCompetitionsList";
import { phase2Copy } from "@/lib/phase2";
import { getCompetitionListing } from "@/lib/phase2-public.server";

export const metadata: Metadata = {
  title: phase2Copy.publicListTitle,
  description: phase2Copy.publicListIntro,
  alternates: { canonical: "/competitions" },
  openGraph: {
    title: phase2Copy.publicListTitle,
    description: messages.seo.competitionsDescription,
    url: "/competitions",
    type: "website",
  },
};

export default async function CompetitionsListPage() {
  // Identical for every visitor: the signed-in name is filled in client-side by IdentityStatus.
  const competitions = await getCompetitionListing();
  return <PublicCompetitionsList competitions={competitions} viewer={null} />;
}
