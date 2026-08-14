import type { Metadata } from "next";
import { MarketingHome } from "@/components/marketing/MarketingHome";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { messages } from "@matchday/ui";

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
  const session = await readCurrentIdentitySession();
  return (
    <MarketingHome
      viewer={session.status === "authenticated" ? { displayName: session.identity.displayName } : null}
    />
  );
}
