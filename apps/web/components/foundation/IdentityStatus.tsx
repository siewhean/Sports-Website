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
  status?: unknown;
  displayName?: unknown;
};

export function IdentityStatus({ className, initialDisplayName = null }: IdentityStatusProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void fetch("/api/identity/current", {
      ...identityStatusRequest,
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as IdentityPayload | null;
        const candidate = payload?.displayName;
        setDisplayName(
          payload?.status === "authenticated" && typeof candidate === "string" && candidate.trim()
            ? candidate.trim()
            : null,
        );
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        // Preserve server-provided identity on transient refresh failures.
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
