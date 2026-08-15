"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { CompetitionCreateDraft } from "./phase3-competition-create";
import {
  competitionCreateDraftStorageKey,
  parseCompetitionCreateDraft,
  serializeCompetitionCreateDraft,
} from "./phase3-competition-draft";

export function useCompetitionCreateDraft(
  draftOwnerId: string,
  initialDraft: () => CompetitionCreateDraft,
): Readonly<{
  draft: CompetitionCreateDraft;
  setDraft: (value: SetStateAction<CompetitionCreateDraft>) => void;
  clearDraft: () => void;
}> {
  const storageKey = competitionCreateDraftStorageKey(draftOwnerId);
  const [draft, setDraftState] = useState(initialDraft);
  const draftRef = useRef(draft);
  const storageReadyRef = useRef(false);

  const writeDraft = useCallback(
    (next: CompetitionCreateDraft) => {
      try {
        window.localStorage.setItem(storageKey, serializeCompetitionCreateDraft(next));
      } catch {
        // Browser storage can be unavailable or quota-limited. The form itself must remain usable.
      }
    },
    [storageKey],
  );

  const setDraft = useCallback(
    (value: SetStateAction<CompetitionCreateDraft>) => {
      const next = typeof value === "function" ? value(draftRef.current) : value;
      draftRef.current = next;
      setDraftState(next);
      if (storageReadyRef.current) writeDraft(next);
    },
    [writeDraft],
  );

  const clearDraft = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // A successful server create must not be turned into a client error by unavailable browser storage.
    }
  }, [storageKey]);

  useEffect(() => {
    storageReadyRef.current = false;
    const restoreTimer = window.setTimeout(() => {
      const emptyDraft = initialDraft();
      draftRef.current = emptyDraft;
      setDraftState(emptyDraft);
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const restored = parseCompetitionCreateDraft(raw);
          if (restored) {
            draftRef.current = restored;
            setDraftState(restored);
          } else {
            window.localStorage.removeItem(storageKey);
          }
        }
      } catch {
        // Treat browser persistence as best effort; server-side validation remains authoritative.
      } finally {
        storageReadyRef.current = true;
      }
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, [initialDraft, storageKey]);

  useEffect(() => {
    const saveBeforeLeaving = () => {
      if (storageReadyRef.current) writeDraft(draftRef.current);
    };
    window.addEventListener("pagehide", saveBeforeLeaving);
    return () => window.removeEventListener("pagehide", saveBeforeLeaving);
  }, [writeDraft]);

  return { draft, setDraft, clearDraft };
}
