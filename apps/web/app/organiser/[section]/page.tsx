import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isOrganiserSection, organiserSections } from "@/lib/phase2";

export function generateStaticParams() {
  return organiserSections
    .filter((section) => section.id !== "control-room")
    .map((section) => ({ section: section.id }));
}

export default async function OrganiserSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isOrganiserSection(section) || section === "control-room") notFound();
  // These bare section routes only exist for the local demo fixture ("Singapore Open 2026"). Real organisers work
  // inside a competition, so send them to the competition library instead of showing invented demo data.
  if (!demoFixturesEnabled()) redirect("/organiser/competitions");
  return <OrganiserWorkspace section={section} />;
}
