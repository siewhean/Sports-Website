import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { OrganiserCompetitionLibrary } from "@/components/phase3/OrganiserCompetitionLibrary";
import { organiserCompetitionLibraryCopy } from "@/lib/organiser-competition-library";
import { getOrganiserCompetitionLibrary } from "@/lib/organiser-competition-library.server";

export const metadata: Metadata = {
  title: organiserCompetitionLibraryCopy.title,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function OrganiserCompetitionsPage() {
  const result = await getOrganiserCompetitionLibrary();
  if (result.state === "permission") redirect("/sign-in");
  if (result.state === "error") throw new Error(organiserCompetitionLibraryCopy.loadError);

  return (
    <ProductionShell
      kind="organiser"
      title={organiserCompetitionLibraryCopy.title}
      subtitle={organiserCompetitionLibraryCopy.subtitle}
    >
      <OrganiserCompetitionLibrary competitions={result.competitions} />
    </ProductionShell>
  );
}
