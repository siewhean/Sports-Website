import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { EventPassCheckout } from "@/components/phase6/EventPassCheckout";
import { getOrganiserCompetitionLibrary } from "@/lib/organiser-competition-library.server";

export const metadata: Metadata = {
  title: "Event Pass checkout",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function EventPassCheckoutPage() {
  const result = await getOrganiserCompetitionLibrary();
  if (result.state === "permission") redirect("/sign-in?returnTo=/organiser/checkout/event-pass");
  if (result.state === "error") throw new Error("Your competitions could not be loaded. No changes were made.");

  return (
    <ProductionShell
      kind="organiser"
      title="Get an Event Pass"
      subtitle="Choose the one competition this pass should unlock, then continue to secure Stripe checkout."
    >
      <EventPassCheckout competitions={result.competitions} />
    </ProductionShell>
  );
}
