import type { Metadata } from "next";
import { LegalPage } from "@/components/foundation/LegalPage";
import { LegalText } from "@/components/foundation/LegalText";
import { legalMessages, messages } from "@matchday/ui";

export const metadata: Metadata = { title: messages.legal.termsTitle, alternates: { canonical: "/terms" } };

export default function TermsPage() {
  // Identical for every visitor: the signed-in name is filled in client-side by IdentityStatus.
  const viewer = null;
  return (
    <LegalPage viewer={viewer} title={messages.legal.termsTitle}>
      <p>
        {legalMessages.lastUpdated}: {legalMessages.updatedOn}
      </p>

      {legalMessages.terms.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <p>
            <LegalText>{section.body}</LegalText>
          </p>
        </section>
      ))}
    </LegalPage>
  );
}
