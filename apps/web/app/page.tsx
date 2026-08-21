import type { Metadata } from "next";
import { MarketingHome } from "@/components/marketing/MarketingHome";
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

export default function Home() {
  return <MarketingHome />;
}
