import { LegalPage } from "@/components/foundation/LegalPage";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { messages } from "@matchday/ui";

export default async function CookiesPage() {
  const session = await readCurrentIdentitySession();
  const viewer = session.status === "authenticated" ? session.identity : null;
  return (
    <LegalPage viewer={viewer} title={messages.legal.cookiesTitle}>
      <p>{messages.legal.cookiesBody}</p>
    </LegalPage>
  );
}
