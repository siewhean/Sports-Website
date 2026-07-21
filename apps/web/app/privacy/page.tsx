import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

export default function PrivacyPage() {
  return (
    <LegalPage title={messages.legal.privacyTitle}>
      <p>{messages.legal.privacyBody}</p>
    </LegalPage>
  );
}
