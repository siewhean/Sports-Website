import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";

export default async function OrganiserLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (demoFixturesEnabled()) return children;
  const session = await readCurrentIdentitySession();
  if (session.status === "step_up_required") redirect("/sign-in?reason=step-up");
  if (session.status !== "authenticated") redirect("/sign-in");
  return children;
}
