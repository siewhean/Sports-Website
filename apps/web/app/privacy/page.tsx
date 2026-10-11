import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/foundation/LegalPage";
import { LegalText } from "@/components/foundation/LegalText";
import { RetentionTable } from "@/components/foundation/RetentionTable";
import { legalMessages, messages, retentionSectionTitle } from "@matchday/ui";

export const metadata: Metadata = { title: messages.legal.privacyTitle, alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  // Identical for every visitor: the signed-in name is filled in client-side by IdentityStatus.
  const viewer = null;
  return (
    <LegalPage viewer={viewer} title={messages.legal.privacyTitle}>
      <p>
        {legalMessages.lastUpdated}: {legalMessages.updatedOn}
      </p>
      <p>{legalMessages.privacy.intro}</p>

      {legalMessages.privacy.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <p>
            <LegalText>{section.body}</LegalText>
          </p>
          {section.title === retentionSectionTitle ? <RetentionTable /> : null}
        </section>
      ))}

      <p>
        <Link href="/account">{legalMessages.privacy.accountLink}</Link>
      </p>
      <p>
        <Link href="/cookies">{legalMessages.privacy.cookiesLink}</Link>
      </p>
    </LegalPage>
  );
}
