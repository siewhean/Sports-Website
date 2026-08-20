import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { CompetitionCreateForm } from "@/components/phase3/CompetitionCreateForm";
import { demoCompetitionDraftOwnerId, demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";

export const metadata: Metadata = {
  title: messages.organiserCreate.title,
  robots: { index: false, follow: false },
};

export default async function CompetitionCreatePage() {
  const demo = demoFixturesEnabled();
  let draftOwnerId = demoCompetitionDraftOwnerId;
  let viewerName: string | null = null;
  if (!demo) {
    const session = await readCurrentIdentitySession();
    if (session.status === "step_up_required") redirect("/sign-in?reason=step-up");
    if (session.status !== "authenticated") redirect("/sign-in");
    draftOwnerId = session.identity.accountId;
    viewerName = session.identity.displayName;
  }

  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiserCreate.title}
      subtitle={messages.organiserCreate.subtitle}
      utility={viewerName ? <span>{viewerName}</span> : undefined}
    >
      <CompetitionCreateForm draftOwnerId={draftOwnerId} />
    </ProductionShell>
  );
}
