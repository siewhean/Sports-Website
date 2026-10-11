import type { Metadata } from "next";
import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

export const metadata: Metadata = { title: messages.legal.cookiesTitle, alternates: { canonical: "/cookies" } };

export default function CookiesPage() {
  // Identical for every visitor: the signed-in name is filled in client-side by IdentityStatus.
  const viewer = null;
  return (
    <LegalPage viewer={viewer} title={messages.legal.cookiesTitle}>
      <p>{messages.legal.cookiesBody}</p>
    </LegalPage>
  );
}
