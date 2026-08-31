import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { EventPassCheckout } from "@/components/phase6/EventPassCheckout";
import { getOrganiserCompetitionLibrary } from "@/lib/organiser-competition-library.server";

export const metadata: Metadata = {
  title: messages.eventPassCheckout.metadataTitle,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function EventPassCheckoutPage() {
  const result = await getOrganiserCompetitionLibrary();
  if (result.state === "permission") redirect("/sign-in?returnTo=/organiser/checkout/event-pass");
  if (result.state === "error") throw new Error(messages.eventPassCheckout.competitionsLoadFailed);

  return (
    <ProductionShell
      kind="organiser"
      title={messages.eventPassCheckout.shellTitle}
      subtitle={messages.eventPassCheckout.shellSubtitle}
    >
      <EventPassCheckout competitions={result.competitions} />
    </ProductionShell>
  );
}
