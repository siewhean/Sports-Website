import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";

const sessionCookieNames = ["__Host-matchday_session", "matchday_session"] as const;
type SessionStatus = "authenticated" | "step_up_required" | "unauthenticated";

function identityApiOrigin(): URL | null {
  const configured = (process.env.RENDER_API_ORIGIN ?? process.env.MATCHDAY_API_BASE_URL)?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

async function organiserSessionStatus(): Promise<SessionStatus> {
  const cookieStore = await cookies();
  const session = sessionCookieNames
    .map((name) => ({ name, value: cookieStore.get(name)?.value }))
    .find((candidate) => Boolean(candidate.value));
  if (!session?.value) return "unauthenticated";

  const apiOrigin = identityApiOrigin();
  if (!apiOrigin) return "unauthenticated";

  try {
    const response = await fetch(new URL("/api/v1/identity/me", apiOrigin), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        cookie: `${session.name}=${encodeURIComponent(session.value)}`,
      },
    });
    if (response.ok) return "authenticated";
    if (response.status === 403) {
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (payload?.error?.code === "STEP_UP_REQUIRED") return "step_up_required";
    }
    return "unauthenticated";
  } catch {
    return "unauthenticated";
  }
}

export default async function OrganiserLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (demoFixturesEnabled()) return children;
  const status = await organiserSessionStatus();
  if (status === "step_up_required") redirect("/sign-in?reason=step-up");
  if (status !== "authenticated") redirect("/sign-in");
  return children;
}
