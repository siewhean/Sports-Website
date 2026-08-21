import type { Metadata } from "next";
import { headers } from "next/headers";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { CompetitionCreateForm } from "@/components/phase3/CompetitionCreateForm";
import { requestPublicOrigin } from "@/lib/phase3-origin";

export const metadata: Metadata = {
  title: messages.organiserCreate.title,
  robots: { index: false, follow: false },
};

export default async function CompetitionCreatePage() {
  const origin = requestPublicOrigin(await headers(), process.env.MATCHDAY_PUBLIC_ORIGIN);
  const signInHref = origin
    ? `/api/v1/identity/authorize?return_to=${encodeURIComponent(`${origin}/organiser/competitions/new`)}`
    : "/api/v1/identity/authorize";

  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiserCreate.title}
      subtitle={messages.organiserCreate.subtitle}
    >
      <CompetitionCreateForm signInHref={signInHref} />
    </ProductionShell>
  );
}
