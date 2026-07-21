import type { Metadata } from "next";
import { messages } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: messages.metadata.forbiddenTitle,
  robots: { index: false, follow: false },
};

export default function ForbiddenPage() {
  return (
    <SystemStatePage
      kind="forbidden"
      code="403"
      title={messages.system.forbiddenTitle}
      body={messages.system.forbiddenBody}
      actionLabel={messages.system.forbiddenAction}
      actionHref="/organiser"
    />
  );
}
