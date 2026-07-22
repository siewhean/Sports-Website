import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { FormatDesignerPrototype } from "@/components/FormatDesignerPrototype";
import { PrototypeShell } from "@/components/PrototypeShell";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { translate as t } from "@matchday/ui";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function FormatPage() {
  await headers();
  if (!demoFixturesEnabled()) notFound();
  return (
    <PrototypeShell routeLabel={t("prototype.0e8c71c5f784")} dark>
      <FormatDesignerPrototype />
    </PrototypeShell>
  );
}
