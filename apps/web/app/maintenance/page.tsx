import type { Metadata } from "next";
import { messages } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: messages.metadata.maintenanceTitle,
  robots: { index: false, follow: false },
};

export default function MaintenancePage() {
  return (
    <SystemStatePage
      kind="maintenance"
      code="503"
      title={messages.system.maintenanceTitle}
      body={messages.system.maintenanceBody}
      detail={messages.system.maintenanceReturn}
      actionLabel={messages.system.maintenanceAction}
      actionHref="/maintenance"
    />
  );
}
