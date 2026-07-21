import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

export default function CookiesPage() {
  return (
    <LegalPage title={messages.legal.cookiesTitle}>
      <p>{messages.legal.cookiesBody}</p>
    </LegalPage>
  );
}
