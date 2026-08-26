import { LegalPage } from "@/components/foundation/LegalPage";
import { legalMessages, messages } from "@matchday/ui";

export default function PrivacyPage() {
  return (
    <LegalPage title={messages.legal.privacyTitle}>
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
