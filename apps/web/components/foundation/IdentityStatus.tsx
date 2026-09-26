"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { messages } from "@matchday/ui";
import { identityStatusRequest } from "@/lib/identity-status";

type IdentityStatusProps = Readonly<{
  className?: string;
  initialDisplayName?: string | null;
}>;

type IdentityPayload = {
  account?: {
    display_name?: unknown;
  };
};

export function IdentityStatus({ className, initialDisplayName = null }: IdentityStatusProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void fetch("/api/v1/identity/me", {
      ...identityStatusRequest,
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setDisplayName(null);
          return;
        }
        const payload = (await response.json().catch(() => null)) as IdentityPayload | null;
        const candidate = payload?.account?.display_name;
        setDisplayName(typeof candidate === "string" && candidate.trim() ? candidate.trim() : null);
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setDisplayName(null);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return displayName ? (
    <Link className={className} href="/organiser" data-identity-state="authenticated">
      {displayName}
    </Link>
  ) : (
    <a className={className} href="/api/v1/identity/authorize" data-identity-state="anonymous">
      {messages.navigation.signIn}
    </a>
  );
}
