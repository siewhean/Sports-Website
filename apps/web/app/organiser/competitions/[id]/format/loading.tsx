import { Phase3RouteLoading } from "@/components/phase3/Phase3RouteLoading";
import { opaqueId, translate as t } from "@matchday/ui";

export default function Loading() {
  return <Phase3RouteLoading label={t("prototype.7d9c2feb8c9a")} variant={opaqueId("settings")} />;
}
