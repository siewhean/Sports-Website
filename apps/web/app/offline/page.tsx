import type { Metadata } from "next";
import { messages } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: messages.metadata.offlineTitle,
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <SystemStatePage
      kind="offline"
      code="OFFLINE"
      title={messages.system.offlineTitle}
      body={messages.system.offlineBody}
      actionLabel={messages.system.offlineAction}
      actionHref="/"
    />
  );
}
