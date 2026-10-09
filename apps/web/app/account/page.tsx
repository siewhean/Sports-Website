import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { messages } from "@matchday/ui";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import AccountPageClient from "./AccountPageClient";

export const metadata: Metadata = {
  title: messages.account.title,
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await readCurrentIdentitySession();
  if (session.status !== "authenticated") redirect("/sign-in");
  return <AccountPageClient displayName={session.identity.displayName} />;
}
