import type { Metadata } from "next";
import { MarketingHome } from "@/components/marketing/MarketingHome";
import { messages } from "@matchday/ui";
import { getCompetitionListing } from "@/lib/phase2-public.server";

export const metadata: Metadata = {
  title: messages.metadata.homeTitle,
  description: messages.metadata.homeDescription,
  alternates: { canonical: "/" },
  openGraph: {
    title: messages.metadata.defaultTitle,
    description: messages.metadata.homeOpenGraphDescription,
    url: "/",
    type: "website",
  },
};

export default async function Home() {
  // The home page must still render during a results outage, so listing failures degrade to an explicit notice.
  // No cookie / identity read: the signed-in name is filled in client-side by IdentityStatus.
  const { competitions, unavailable } = await getCompetitionListing().then(
    (competitions) => ({ competitions, unavailable: false }),
    () => ({ competitions: [], unavailable: true }),
  );
  return <MarketingHome viewer={null} competitions={competitions} unavailable={unavailable} />;
}
