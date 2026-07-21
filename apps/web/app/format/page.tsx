import { FormatDesignerPrototype } from "@/components/FormatDesignerPrototype";
import { PrototypeShell } from "@/components/PrototypeShell";
import { translate as t } from "@matchday/ui";

export default function FormatPage() {
  return (
    <PrototypeShell routeLabel={t("prototype.0e8c71c5f784")} dark>
      <FormatDesignerPrototype />
    </PrototypeShell>
  );
}
