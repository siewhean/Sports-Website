import type { Metadata } from "next";
import { headers } from "next/headers";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { CompetitionCreateForm } from "@/components/phase3/CompetitionCreateForm";
import { requestForwardedOrigin } from "@/lib/phase3-origin";

export const metadata: Metadata = {
  title: messages.organiserCreate.title,
  robots: { index: false, follow: false },
};

function requestOrigin(requestHeaders: Headers): string | null {
  return requestForwardedOrigin(requestHeaders);
}

export default async function CompetitionCreatePage() {
  const origin = requestOrigin(await headers());
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
