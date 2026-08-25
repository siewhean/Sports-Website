import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

export default function TermsPage() {
  return (
    <LegalPage title={messages.legal.termsTitle}>
      <p>{messages.legal.termsBody}</p>
    </LegalPage>
  );
}
