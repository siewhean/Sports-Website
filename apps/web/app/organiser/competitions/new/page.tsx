import type { Metadata } from "next";
import { messages } from "@matchday/ui";
import { ProductionShell } from "@/components/foundation/ProductionShell";
import { CompetitionCreateForm } from "@/components/phase3/CompetitionCreateForm";

export const metadata: Metadata = {
  title: messages.organiserCreate.title,
  robots: { index: false, follow: false },
};

export default function CompetitionCreatePage() {
  return (
    <ProductionShell
      kind="organiser"
      title={messages.organiserCreate.title}
      subtitle={messages.organiserCreate.subtitle}
    >
      <CompetitionCreateForm />
    </ProductionShell>
  );
}
