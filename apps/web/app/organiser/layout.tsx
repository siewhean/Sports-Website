import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const sessionCookieNames = ["__Host-matchday_session", "matchday_session"] as const;

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

async function hasAuthenticatedSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = sessionCookieNames
    .map((name) => ({ name, value: cookieStore.get(name)?.value }))
    .find((candidate) => Boolean(candidate.value));
  if (!session?.value) return false;

  const apiOrigin = identityApiOrigin();
  if (!apiOrigin) return false;

  try {
    const response = await fetch(new URL("/api/v1/identity/me", apiOrigin), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        cookie: `${session.name}=${encodeURIComponent(session.value)}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export default async function OrganiserLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!(await hasAuthenticatedSession())) redirect("/sign-in");
  return children;
}
