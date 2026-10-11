"use client";

import { useEffect } from "react";
import { PublicResultsUnavailable } from "@/components/phase2/PublicResultsUnavailable";

// Covers the competitions list, a competition page and its match pages (error boundaries wrap nested segments).
// A genuine 404 still reaches notFound(); only upstream outages (429, 5xx, network) throw and land here.
export default function CompetitionsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("MATCHDAY public results unavailable", { reference: error.digest ?? null });
  }, [error]);
  return <PublicResultsUnavailable retry={retry} />;
}
