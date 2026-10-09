import type { Metadata } from "next";
import { MarketingHome } from "@/components/marketing/MarketingHome";
import { messages } from "@matchday/ui";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { getCompetitionListing } from "@/lib/phase2-public.server";

export const metadata: Metadata = {
  title: messages.metadata.homeTitle,
  description: messages.metadata.homeDescription,
  openGraph: {
    title: messages.metadata.defaultTitle,
    description: messages.metadata.homeOpenGraphDescription,
    type: "website",
  },
};

export default async function Home() {
  // The home page must still render during a results outage, so listing failures degrade to an explicit notice.
  const listing = getCompetitionListing().then(
    (competitions) => ({ competitions, unavailable: false }),
    () => ({ competitions: [], unavailable: true }),
  );
  const [session, { competitions, unavailable }] = await Promise.all([readCurrentIdentitySession(), listing]);
  return (
    <MarketingHome
      viewer={session.status === "authenticated" ? session.identity : null}
      competitions={competitions}
      unavailable={unavailable}
    />
  );
}
