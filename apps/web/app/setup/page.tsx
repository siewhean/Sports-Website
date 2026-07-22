import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AssistedSetupPrototype } from "@/components/AssistedSetupPrototype";
import { PrototypeShell } from "@/components/PrototypeShell";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { translate as t } from "@matchday/ui";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SetupPage() {
  await headers();
  if (!demoFixturesEnabled()) notFound();
  return (
    <PrototypeShell routeLabel={t("prototype.fe48ad8a445f")}>
      <AssistedSetupPrototype />
    </PrototypeShell>
  );
}
