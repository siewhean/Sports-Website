import { notFound } from "next/navigation";
import { PrototypeShell } from "@/components/PrototypeShell";
import { ScorekeeperPrototype } from "@/components/ScorekeeperPrototype";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { translate as t } from "@matchday/ui";

export default function ScorekeeperPrototypePage() {
  if (!demoFixturesEnabled()) notFound();

  return (
    <PrototypeShell routeLabel={t("prototype.11b172ceab02")} scoring>
      <ScorekeeperPrototype />
    </PrototypeShell>
  );
}
