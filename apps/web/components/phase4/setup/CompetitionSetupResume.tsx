"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  competitionSetupResumeHref,
  competitionSetupResumeStorageKey,
  parseCompetitionSetupResume,
  serializeCompetitionSetupResume,
  type CompetitionSetupResume,
} from "@/lib/competition-setup-resume";

export function SyncCompetitionSetupResume({
  accountId,
  competitionId,
  competitionName,
  active,
}: Readonly<{
  accountId: string;
  competitionId: string;
  competitionName: string;
  active: boolean;
}>) {
  useEffect(() => {
    const key = competitionSetupResumeStorageKey(accountId);
    if (active) {
      window.localStorage.setItem(key, serializeCompetitionSetupResume({ competitionId, competitionName }));
      return;
    }
    const current = parseCompetitionSetupResume(window.localStorage.getItem(key));
    if (current?.competitionId === competitionId) window.localStorage.removeItem(key);
  }, [accountId, active, competitionId, competitionName]);

  return null;
}

export function CompetitionSetupActions({
  accountId,
  createLabel,
}: Readonly<{ accountId: string | null; createLabel: string }>) {
  const [resume, setResume] = useState<CompetitionSetupResume | null>(null);

  useEffect(() => {
    if (!accountId) {
      setResume(null);
      return;
    }
    const key = competitionSetupResumeStorageKey(accountId);
    const raw = window.localStorage.getItem(key);
    const parsed = parseCompetitionSetupResume(raw);
    if (!parsed && raw) window.localStorage.removeItem(key);
    setResume(parsed);
  }, [accountId]);

  return (
    <span style={{ display: "grid", gap: "8px" }}>
      {resume ? (
        <Link className="foundation-action foundation-action--signal" href={competitionSetupResumeHref(resume)}>
          <span>Continue setup · {resume.competitionName}</span>
          <span className="foundation-action__icon" aria-hidden="true">
            →
          </span>
        </Link>
      ) : null}
      <Link className="foundation-action foundation-action--dark" href="/organiser/competitions/new">
        <span>{createLabel}</span>
        <span className="foundation-action__icon" aria-hidden="true">
          →
        </span>
      </Link>
    </span>
  );
}
