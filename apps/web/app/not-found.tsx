import { messages } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export default function NotFound() {
  return (
    <SystemStatePage
      kind="missing"
      code="404"
      title={messages.system.notFoundTitle}
      body={messages.system.notFoundBody}
      actionLabel={messages.system.notFoundAction}
      actionHref="/"
    />
  );
}
