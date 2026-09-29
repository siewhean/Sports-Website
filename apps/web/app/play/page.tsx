import type { Metadata } from "next";
import { CasualSetup } from "@/components/casual/CasualSetup";
import { casualCopy } from "@/lib/casual-copy";

export const metadata: Metadata = { title: casualCopy.pageTitle, description: casualCopy.pageDescription };

export default function PlayPage() {
  return <CasualSetup />;
}
