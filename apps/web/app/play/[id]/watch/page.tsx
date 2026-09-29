import type { Metadata } from "next";
import { CasualBoard } from "@/components/casual/CasualBoard";
import { casualCopy } from "@/lib/casual-copy";
import { opaqueId } from "@matchday/ui";

export const metadata: Metadata = { title: casualCopy.watchPageTitle, robots: { index: false, follow: false } };

export default async function CasualWatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewer_token?: string }>;
}) {
  const [{ id }, { viewer_token }] = await Promise.all([params, searchParams]);
  return <CasualBoard id={id} mode={opaqueId("viewer")} viewerToken={viewer_token} />;
}
