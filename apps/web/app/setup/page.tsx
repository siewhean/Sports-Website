import { AssistedSetupPrototype } from "@/components/AssistedSetupPrototype";
import { PrototypeShell } from "@/components/PrototypeShell";
import { translate as t } from "@matchday/ui";

export default function SetupPage() {
  return (
    <PrototypeShell routeLabel={t("prototype.fe48ad8a445f")}>
      <AssistedSetupPrototype />
    </PrototypeShell>
  );
}
