import type { Metadata } from "next";
import { PublicCompetitionsList } from "@/components/phase2/PublicCompetitionsList";
import { phase2Copy } from "@/lib/phase2";
import { getCompetitionListing } from "@/lib/phase2-public.server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";

export const metadata: Metadata = {
  title: phase2Copy.publicListTitle,
  description: phase2Copy.publicListIntro,
};

export default async function CompetitionsListPage() {
  const [competitions, session] = await Promise.all([getCompetitionListing(), readCurrentIdentitySession()]);
  const viewer = session.status === "authenticated" ? { displayName: session.identity.displayName } : null;
  return <PublicCompetitionsList competitions={competitions} viewer={viewer} />;
}
