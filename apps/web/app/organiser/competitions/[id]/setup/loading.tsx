import { Phase3RouteLoading } from "@/components/phase3/Phase3RouteLoading";
import { opaqueId, translate as t } from "@matchday/ui";

export default function Loading() {
  return <Phase3RouteLoading label={t("prototype.70dd2f18c378")} variant={opaqueId("settings")} />;
}
