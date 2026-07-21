"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Phase4SetupDocument,
  Phase4SetupStepId,
  Phase4SetupStepValue,
} from "@matchday/contracts";
import { opaqueId } from "@matchday/ui";
import {
  parseAssistedSetupAutosaveResponse,
  phase4SetupCopy,
  setupAutosaveBody,
  stepValue,
  type AssistedSetupPageDocument,
  type AssistedSetupSurfaceState,
} from "@/lib/phase4-assisted-setup";
import {
  patchableSetupStep,
  setupMutationDocument,
  setupMutationSucceeded,
  setupStepForSave,
  setupValuesEqual,
} from "@/lib/phase4-assisted-setup-flow";
import { setupPatchBody } from "@/lib/phase4-assisted-setup-patch";
import { AssistedSetupJourneyView } from "./AssistedSetupJourneyView";

type BasicsDraft = NonNullable<Phase4SetupDocument["values"]["basics"]>;
type PreferencesDraft = NonNullable<Phase4SetupDocument["values"]["format_preferences"]>;
type SetupMutationMethod = "PATCH" | "PUT";

const copy = {
  autosaveError: opaqueId("Draft autosave failed. Your local edits are preserved."),
  incomplete: opaqueId("Complete the required fields before continuing."),
  briefReading: opaqueId("Reading your competition brief…"),
  briefFallback: opaqueId("Your text is preserved. Continue with the guided fields below."),
  briefReview: opaqueId("Review the populated fields. Missing information is linked below."),
  expired: opaqueId("This setup draft expired. Reload to review its non-editable audit state."),
} as const;

export function AssistedSetupJourney({ document }: { document: AssistedSetupPageDocument }) {
  const [setup, setSetupState] = useState(document.setup);
  const setupRef = useRef(document.setup);
  const [viewState, setViewStateState] = useState(document.state);
  const viewStateRef = useRef(document.state);
  const [commandBusy, setCommandBusy] = useState(false);
  const commandLockRef = useRef(false);
  const [autosaving, setAutosaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [basics, setBasicsState] = useState<BasicsDraft | null>(() => document.setup?.values.basics ?? null);
  const basicsRef = useRef<BasicsDraft | null>(document.setup?.values.basics ?? null);
  const [preferences, setPreferencesState] = useState<PreferencesDraft | null>(
    () => document.setup?.values.format_preferences ?? null,
  );
  const preferencesRef = useRef<PreferencesDraft | null>(document.setup?.values.format_preferences ?? null);
  const [brief, setBrief] = useState("");
  const [briefMessage, setBriefMessage] = useState("");
  const [missingFields, setMissingFields] = useState<readonly string[]>([]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutationQueueRef = useRef<Promise<Phase4SetupDocument | null>>(Promise.resolve(document.setup));

  const setSetup = useCallback((value: Phase4SetupDocument | null) => {
    setupRef.current = value;
    setSetupState(value);
  }, []);

  const setViewState = useCallback((value: AssistedSetupSurfaceState) => {
    viewStateRef.current = value;
    setViewStateState(value);
  }, []);

  const setBasics = useCallback((value: BasicsDraft) => {
    basicsRef.current = value;
    setBasicsState(value);
  }, []);

  const setPreferences = useCallback((value: PreferencesDraft) => {
    preferencesRef.current = value;
    setPreferencesState(value);
  }, []);

  const readOnlyNow = useCallback(() => {
    const current = setupRef.current;
    return !current || current.read_only || current.permission !== "write" || viewStateRef.current === "read-only";
  }, []);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  const enqueue = useCallback((operation: () => Promise<Phase4SetupDocument | null>) => {
    const queued = mutationQueueRef.current.catch(() => setupRef.current).then(operation);
    mutationQueueRef.current = queued;
    return queued;
  }, []);

  const applyServerDocument = useCallback(
    (next: Phase4SetupDocument, sentStep?: Phase4SetupStepValue) => {
      setSetup(next);
      setViewState(next.read_only ? opaqueId("read-only") : opaqueId("ready"));
      if (
        sentStep?.step_id === "basics" &&
        basicsRef.current &&
        setupValuesEqual(basicsRef.current, sentStep.value)
      ) {
        basicsRef.current = next.values.basics;
        setBasicsState(next.values.basics);
      }
      if (
        sentStep?.step_id === "format_preferences" &&
        preferencesRef.current &&
        setupValuesEqual(preferencesRef.current, sentStep.value)
      ) {
        preferencesRef.current = next.values.format_preferences;
        setPreferencesState(next.values.format_preferences);
      }
    },
    [setSetup, setViewState],
  );

  const sendMutation = useCallback(
    async (
      method: SetupMutationMethod,
      body: unknown,
      sentStep?: Phase4SetupStepValue,
    ): Promise<Phase4SetupDocument | null> => {
      try {
        const response = await fetch(
          `/api/phase4/competitions/${encodeURIComponent(document.competitionId)}/setup-draft`,
          {
            method: opaqueId(method),
            headers: { "content-type": opaqueId("application/json") },
            body: JSON.stringify(body),
          },
        );
        const parsed = parseAssistedSetupAutosaveResponse(
          await response.json().catch(() => null),
          document.competitionId,
        );
        if (!response.ok || !parsed) {
          if (response.status === 401 || response.status === 403) setViewState(opaqueId("permission"));
          else if (response.status === 409) setViewState(opaqueId("conflict"));
          else setAnnouncement(copy.autosaveError);
          return null;
        }
        const next = setupMutationDocument(parsed);
        if (!setupMutationSucceeded(parsed)) {
          setSetup(next);
          if (parsed.outcome === "read_only") setViewState(opaqueId("read-only"));
          else if (parsed.outcome === "expired") {
            setViewState(opaqueId("error"));
            setAnnouncement(copy.expired);
          } else setViewState(opaqueId("conflict"));
          return null;
        }
        applyServerDocument(next, sentStep);
        setAnnouncement(phase4SetupCopy.saved);
        return next;
      } catch {
        setViewState(opaqueId("offline"));
        setAnnouncement(copy.autosaveError);
        return null;
      }
    },
    [applyServerDocument, document.competitionId, setSetup, setViewState],
  );

  const patchLatestEditableStep = useCallback(async (): Promise<Phase4SetupDocument | null> => {
    clearAutosaveTimer();
    await mutationQueueRef.current.catch(() => setupRef.current);
    const source = setupRef.current;
    if (!source || readOnlyNow()) return source;
    const step = patchableSetupStep(source.current_step, basicsRef.current, preferencesRef.current);
    if (!step || setupValuesEqual(source.values[step.step_id], step.value)) return source;
    return enqueue(async () => {
      const current = setupRef.current;
      if (!current || readOnlyNow()) return current;
      const latest = patchableSetupStep(current.current_step, basicsRef.current, preferencesRef.current);
      if (!latest || setupValuesEqual(current.values[latest.step_id], latest.value)) return current;
      setAutosaving(true);
      setAnnouncement(phase4SetupCopy.saving);
      try {
        return await sendMutation("PATCH", setupPatchBody(current.revision, latest), latest);
      } finally {
        setAutosaving(false);
      }
    });
  }, [clearAutosaveTimer, enqueue, readOnlyNow, sendMutation]);

  const saveCurrentStep = useCallback(async (): Promise<Phase4SetupDocument | null> => {
    clearAutosaveTimer();
    await mutationQueueRef.current.catch(() => setupRef.current);
    return enqueue(async () => {
      const source = setupRef.current;
      if (!source || readOnlyNow()) return null;
      const step = setupStepForSave(source, basicsRef.current, preferencesRef.current);
      if (!step) {
        setAnnouncement(copy.incomplete);
        return null;
      }
      return sendMutation("PUT", setupAutosaveBody(source.revision, { kind: "save_step", step }), step);
    });
  }, [clearAutosaveTimer, enqueue, readOnlyNow, sendMutation]);

  const withCommandLock = useCallback(async (operation: () => Promise<void>) => {
    if (commandLockRef.current) return;
    commandLockRef.current = true;
    setCommandBusy(true);
    try {
      await operation();
    } finally {
      commandLockRef.current = false;
      setCommandBusy(false);
    }
  }, []);

  const goTo = useCallback(
    async (target: Phase4SetupStepId) =>
      withCommandLock(async () => {
        const source = setupRef.current;
        if (!source || target === source.current_step) return;
        const sourceIndex = assistedSetupSteps.findIndex((step) => step.id === source.current_step);
        const targetIndex = assistedSetupSteps.findIndex((step) => step.id === target);
        if (targetIndex > sourceIndex) {
          const saved = await saveCurrentStep();
          if (!saved || saved.current_step === target) return;
        } else {
          const patched = await patchLatestEditableStep();
          if (!patched) return;
        }
        await enqueue(async () => {
          const current = setupRef.current;
          if (!current) return null;
          return sendMutation("PUT", setupAutosaveBody(current.revision, { kind: "go_to_step", step_id: target }));
        });
      }),
    [enqueue, patchLatestEditableStep, saveCurrentStep, sendMutation, withCommandLock],
  );

  const continueToNext = useCallback(
    async () => withCommandLock(async () => void (await saveCurrentStep())),
    [saveCurrentStep, withCommandLock],
  );

  const selectRecommendation = useCallback(
    async (id: string, acknowledged: boolean) =>
      withCommandLock(async () => {
        const current = setupRef.current;
        const selection = current?.values.format_recommendations;
        if (!current || !selection || readOnlyNow()) return;
        const step = stepValue(opaqueId("format_recommendations"), {
          ...selection,
          selected_recommendation_id: id,
          acknowledged_capacity_shortfall: acknowledged,
        });
        await enqueue(async () => {
          const latest = setupRef.current;
          if (!latest) return null;
          return sendMutation("PUT", setupAutosaveBody(latest.revision, { kind: "save_step", step }), step);
        });
      }),
    [enqueue, readOnlyNow, sendMutation, withCommandLock],
  );

  const completeSetup = useCallback(
    async () =>
      withCommandLock(async () => {
        const current = setupRef.current;
        if (!current?.values.review_publish || readOnlyNow()) return;
        await patchLatestEditableStep();
        await enqueue(async () => {
          const latest = setupRef.current;
          if (!latest?.values.review_publish) return null;
          return sendMutation(
            "PUT",
            setupAutosaveBody(latest.revision, {
              kind: "complete",
              review: latest.values.review_publish,
            }),
          );
        });
      }),
    [enqueue, patchLatestEditableStep, readOnlyNow, sendMutation, withCommandLock],
  );

  const createDraft = useCallback(
    async () =>
      withCommandLock(async () => {
        try {
          const response = await fetch(
            `/api/phase4/competitions/${encodeURIComponent(document.competitionId)}/setup-draft`,
            {
              method: opaqueId("POST"),
              headers: { "content-type": opaqueId("application/json") },
              body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
            },
          );
          if (response.ok) window.location.reload();
          else setViewState(response.status === 401 || response.status === 403 ? opaqueId("permission") : opaqueId("error"));
        } catch {
          setViewState(opaqueId("offline"));
        }
      }),
    [document.competitionId, setViewState, withCommandLock],
  );

  const convertBrief = useCallback(
    async () =>
      withCommandLock(async () => {
        const current = setupRef.current;
        if (!current || !brief.trim()) return;
        setBriefMessage(copy.briefReading);
        try {
          const response = await fetch(
            `/api/phase4/organisations/${encodeURIComponent(current.organisation_id)}/ai/competition-brief`,
            {
              method: opaqueId("POST"),
              headers: { "content-type": opaqueId("application/json") },
              body: JSON.stringify({
                idempotency_key: crypto.randomUUID(),
                text: brief,
                locale: basicsRef.current?.locale ?? "en-SG",
                competition_id: current.competition_id,
              }),
            },
          );
          const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (!response.ok || !payload || payload.status !== "success" || !payload.brief || typeof payload.brief !== "object") {
            setBriefMessage(copy.briefFallback);
            return;
          }
          const generated = payload.brief as Record<string, unknown>;
          const location = generated.location as Record<string, unknown> | null;
          const dates = generated.dates as Record<string, unknown> | null;
          const currentBasics = basicsRef.current;
          if (currentBasics) {
            setBasics({
              ...currentBasics,
              name: typeof generated.name === "string" ? generated.name : currentBasics.name,
              sport_code:
                typeof generated.sport === "string"
                  ? (generated.sport as BasicsDraft["sport_code"])
                  : currentBasics.sport_code,
              entry_count: typeof generated.entry_count === "number" ? generated.entry_count : currentBasics.entry_count,
              division_count:
                typeof generated.division_count === "number" ? generated.division_count : currentBasics.division_count,
              starts_on: typeof dates?.start === "string" ? dates.start : currentBasics.starts_on,
              ends_on: typeof dates?.end === "string" ? dates.end : currentBasics.ends_on,
              location: {
                ...currentBasics.location,
                venue: typeof location?.venue === "string" ? location.venue : currentBasics.location.venue,
                address: typeof location?.address === "string" ? location.address : currentBasics.location.address,
                locality: typeof location?.locality === "string" ? location.locality : currentBasics.location.locality,
                country_code:
                  typeof location?.country_code === "string" ? location.country_code : currentBasics.location.country_code,
              },
            });
          }
          setMissingFields(Array.isArray(payload.missing_fields) ? payload.missing_fields.filter(isString) : []);
          setBriefMessage(copy.briefReview);
        } catch {
          setBriefMessage(copy.briefFallback);
        }
      }),
    [brief, setBasics, withCommandLock],
  );

  const currentStep = setup?.current_step ?? "basics";
  const readOnly = !setup || setup.read_only || setup.permission !== "write" || viewState === "read-only";

  useEffect(() => {
    headingRef.current?.focus();
  }, [currentStep]);

  useEffect(() => {
    clearAutosaveTimer();
    const current = setupRef.current;
    if (!current || readOnly) return;
    const step = patchableSetupStep(current.current_step, basics, preferences);
    if (!step || setupValuesEqual(current.values[step.step_id], step.value)) return;
    autosaveTimerRef.current = setTimeout(() => {
      void patchLatestEditableStep();
    }, 750);
    return clearAutosaveTimer;
  }, [basics, clearAutosaveTimer, currentStep, patchLatestEditableStep, preferences, readOnly]);

  useEffect(() => clearAutosaveTimer, [clearAutosaveTimer]);

  return (
    <AssistedSetupJourneyView
      document={document}
      setup={setup}
      viewState={viewState}
      commandBusy={commandBusy}
      autosaving={autosaving}
      announcement={announcement}
      basics={basics}
      preferences={preferences}
      brief={brief}
      briefMessage={briefMessage}
      missingFields={missingFields}
      headingRef={headingRef}
      onBasics={setBasics}
      onPreferences={setPreferences}
      onBrief={setBrief}
      onConvertBrief={() => void convertBrief()}
      onCreateDraft={() => void createDraft()}
      onGoTo={(step) => void goTo(step)}
      onContinue={() => void continueToNext()}
      onSelectRecommendation={(id, acknowledged) => void selectRecommendation(id, acknowledged)}
      onComplete={() => void completeSetup()}
    />
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
