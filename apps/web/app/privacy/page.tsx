import { LegalPage } from "@/components/foundation/LegalPage";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { legalMessages, messages } from "@matchday/ui";

export default async function PrivacyPage() {
  const session = await readCurrentIdentitySession();
  const viewer = session.status === "authenticated" ? session.identity : null;
  return (
    <LegalPage viewer={viewer} title={messages.legal.privacyTitle}>
      <p>
        {legalMessages.lastUpdated}: {legalMessages.updatedOn}
      </p>

      {legalMessages.privacy.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <p>{section.body}</p>
        </section>
      ))}
    </LegalPage>
  );
}
