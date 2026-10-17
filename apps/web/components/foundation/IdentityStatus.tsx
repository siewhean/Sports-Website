"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { messages } from "@matchday/ui";
import { identityStatusRequest } from "@/lib/identity-status";

type IdentityStatusProps = Readonly<{
  className?: string;
  initialDisplayName?: string | null;
  /** Called once the signed-in name is known (null when signed out), e.g. for the account menu initials. */
  onResolved?: (displayName: string | null) => void;
}>;

type IdentityPayload = {
  status?: unknown;
  displayName?: unknown;
};

export function IdentityStatus({ className, initialDisplayName = null, onResolved }: IdentityStatusProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  });

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
        const resolved =
          payload?.status === "authenticated" && typeof candidate === "string" && candidate.trim()
            ? candidate.trim()
            : null;
        setDisplayName(resolved);
        onResolvedRef.current?.(resolved);
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
