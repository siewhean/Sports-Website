import { notFound } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { isOrganiserSection, organiserSections } from "@/lib/phase2";

export function generateStaticParams() {
  return organiserSections
    .filter((section) => section.id !== "control-room")
    .map((section) => ({ section: section.id }));
}

export default async function OrganiserSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isOrganiserSection(section) || section === "control-room") notFound();
  return <OrganiserWorkspace section={section} />;
}
