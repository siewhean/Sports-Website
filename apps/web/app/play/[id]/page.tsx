import type { Metadata } from "next";
import { CasualBoard } from "@/components/casual/CasualBoard";
import { casualCopy } from "@/lib/casual-copy";
import { opaqueId } from "@matchday/ui";

export const metadata: Metadata = { title: casualCopy.hostPageTitle, robots: { index: false, follow: false } };

export default async function CasualHostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CasualBoard id={id} mode={opaqueId("host")} />;
}
