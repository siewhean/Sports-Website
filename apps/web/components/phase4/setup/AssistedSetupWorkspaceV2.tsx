"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  Check,
  CloudSlash,
  Gauge,
  Info,
  MagicWand,
  ShieldCheck,
  Sparkle,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import type {
  Phase4PatchableSetupStep,
  Phase4SetupDocument,
  Phase4SetupStepId,
  Phase4SetupStepValue,
} from "@matchday/contracts";
import { opaqueId, translate as t } from "@matchday/ui";
import {
  assistedSetupSteps,
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
  setupSportLabel,
  setupStepForSave,
  setupValuesEqual,
} from "@/lib/phase4-assisted-setup-flow";
import { setupPatchBody } from "@/lib/phase4-assisted-setup-patch";
import styles from "./AssistedSetupWorkspace.module.css";

type BasicsDraft = NonNullable<Phase4SetupDocument["values"]["basics"]>;
type PreferencesDraft = NonNullable<Phase4SetupDocument["values"]["format_preferences"]>;
type SetupMutationMethod = "PATCH" | "PUT";

const stateCopy: Record<
  Exclude<AssistedSetupSurfaceState, "ready" | "loading" | "empty">,
  { title: string; body: string }
> = {
  error: { title: t("prototype.073e5db01546"), body: t("prototype.198b6e228883") },
  offline: { title: phase4SetupCopy.offline, body: t("prototype.305006a60cee") },
  permission: { title: phase4SetupCopy.permission, body: t("prototype.72b2c902df68") },
  "read-only": { title: phase4SetupCopy.readOnly, body: t("prototype.4f2da4d7aaa9") },
  conflict: { title: phase4SetupCopy.conflict, body: t("prototype.ab445f863ccd") },
  quota: { title: phase4SetupCopy.quota, body: t("prototype.3f9a74ef1f28") },
  plan: { title: phase4SetupCopy.plan, body: t("prototype.4e1fab500c6e") },
};

const flowCopy = {
  autosaveError: opaqueId("Draft autosave failed. Your local edits are preserved."),
  incomplete: opaqueId("Complete the required fields before continuing."),
  briefReading: opaqueId("Reading your competition brief…"),
  briefFallback: opaqueId("Your text is preserved. Continue with the guided fields below."),
  briefReview: opaqueId("Review the populated fields. Missing information is linked below."),
  sportReset: opaqueId(
    "Changing sport resets the pinned recommended settings and invalidates dependent capacity, format, and schedule evidence.",
  ),
  canonicalRules: opaqueId("Pinned sport rules"),
  confirmed: opaqueId("Confirmed"),
  estimated: opaqueId("Estimated"),
  countryCode: opaqueId("Country code"),
  locality: opaqueId("Locality"),
  timezone: opaqueId("Time zone"),
  locale: opaqueId("Locale"),
  entryStatus: opaqueId("Entry count status"),
} as const;

export function AssistedSetupWorkspaceV2({ document }: { document: AssistedSetupPageDocument }) {
  const [setup, setSetup] = useState(document.setup);
  const setupRef = useRef(document.setup);
  const [viewState, setViewState] = useState(document.state);
  const [commandBusy, setCommandBusy] = useState(false);
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

  const currentStep = setup?.current_step ?? "basics";
  const foundIndex = assistedSetupSteps.findIndex((step) => step.id === currentStep);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;
  const readOnly = !setup || setup.read_only || setup.permission !== "write" || viewState === "read-only";
  const currentErrors = setup?.steps.find((step) => step.id === currentStep)?.errors ?? [];

  function setBasics(value: BasicsDraft) {
    basicsRef.current = value;
    setBasicsState(value);
  }

  function setPreferences(value: PreferencesDraft) {
    preferencesRef.current = value;
    setPreferencesState(value);
  }

  function clearAutosaveTimer() {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }

  function enqueue(operation: () => Promise<Phase4SetupDocument | null>) {
    const queued = mutationQueueRef.current.catch(() => setupRef.current).then(operation);
    mutationQueueRef.current = queued;
    return queued;
  }

  function applyServerDocument(next: Phase4SetupDocument, sentStep?: Phase4SetupStepValue) {
    setupRef.current = next;
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
  }

  async function sendMutation(
    method: SetupMutationMethod,
    body: Record<string, unknown>,
    sentStep?: Phase4SetupStepValue,
  ): Promise<Phase4SetupDocument | null> {
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
        else setAnnouncement(flowCopy.autosaveError);
        return null;
      }
      const next = setupMutationDocument(parsed);
      if (!setupMutationSucceeded(parsed)) {
        setupRef.current = next;
        setSetup(next);
        setViewState(parsed.outcome === "read_only" ? opaqueId("read-only") : opaqueId("conflict"));
        return null;
      }
      applyServerDocument(next, sentStep);
      setAnnouncement(phase4SetupCopy.saved);
      return next;
    } catch {
      setViewState(opaqueId("offline"));
      setAnnouncement(flowCopy.autosaveError);
      return null;
    }
  }

  async function patchLatestEditableStep(): Promise<Phase4SetupDocument | null> {
    clearAutosaveTimer();
    await mutationQueueRef.current.catch(() => setupRef.current);
    const source = setupRef.current;
    if (!source || readOnly) return source;
    const step = patchableSetupStep(source.current_step, basicsRef.current, preferencesRef.current);
    if (!step || setupValuesEqual(source.values[step.step_id], step.value)) return source;
    return enqueue(async () => {
      const current = setupRef.current;
      if (!current || readOnly) return current;
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
  }

  async function saveCurrentStep(): Promise<Phase4SetupDocument | null> {
    clearAutosaveTimer();
    await mutationQueueRef.current.catch(() => setupRef.current);
    return enqueue(async () => {
      const source = setupRef.current;
      if (!source || readOnly) return null;
      const step = setupStepForSave(source, basicsRef.current, preferencesRef.current);
      if (!step) {
        setAnnouncement(flowCopy.incomplete);
        return null;
      }
      return sendMutation(
        "PUT",
        setupAutosaveBody(source.revision, { kind: "save_step", step }) as unknown as Record<string, unknown>,
        step,
      );
    });
  }

  async function goTo(target: Phase4SetupStepId) {
    if (!setupRef.current || commandBusy || target === setupRef.current.current_step) return;
    setCommandBusy(true);
    try {
      const source = setupRef.current;
      const sourceIndex = assistedSetupSteps.findIndex((step) => step.id === source.current_step);
      const targetIndex = assistedSetupSteps.findIndex((step) => step.id === target);
      if (targetIndex > sourceIndex) {
        const saved = await saveCurrentStep();
        if (!saved) return;
        if (saved.current_step === target) return;
      } else {
        const patched = await patchLatestEditableStep();
        if (!patched) return;
      }
      await enqueue(async () => {
        const current = setupRef.current;
        if (!current) return null;
        return sendMutation(
          "PUT",
          setupAutosaveBody(current.revision, { kind: "go_to_step", step_id: target }) as unknown as Record<
            string,
            unknown
          >,
        );
      });
    } finally {
      setCommandBusy(false);
    }
  }

  async function continueToNext() {
    if (commandBusy) return;
    setCommandBusy(true);
    try {
      await saveCurrentStep();
    } finally {
      setCommandBusy(false);
    }
  }

  async function selectRecommendation(id: string, acknowledged: boolean) {
    const current = setupRef.current;
    const selection = current?.values.format_recommendations;
    if (!current || !selection || commandBusy || readOnly) return;
    setCommandBusy(true);
    const step = stepValue(opaqueId("format_recommendations"), {
      ...selection,
      selected_recommendation_id: id,
      acknowledged_capacity_shortfall: acknowledged,
    });
    try {
      await enqueue(async () => {
        const latest = setupRef.current;
        if (!latest) return null;
        return sendMutation(
          "PUT",
          setupAutosaveBody(latest.revision, { kind: "save_step", step }) as unknown as Record<string, unknown>,
          step,
        );
      });
    } finally {
      setCommandBusy(false);
    }
  }

  async function completeSetup() {
    const current = setupRef.current;
    if (!current?.values.review_publish || commandBusy || readOnly) return;
    setCommandBusy(true);
    try {
      await patchLatestEditableStep();
      await enqueue(async () => {
        const latest = setupRef.current;
        if (!latest?.values.review_publish) return null;
        return sendMutation(
          "PUT",
          setupAutosaveBody(latest.revision, {
            kind: "complete",
            review: latest.values.review_publish,
          }) as unknown as Record<string, unknown>,
        );
      });
    } finally {
      setCommandBusy(false);
    }
  }

  async function createDraft() {
    if (commandBusy) return;
    setCommandBusy(true);
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
      else
        setViewState(response.status === 401 || response.status === 403 ? opaqueId("permission") : opaqueId("error"));
    } catch {
      setViewState(opaqueId("offline"));
    } finally {
      setCommandBusy(false);
    }
  }

  async function convertBrief() {
    const current = setupRef.current;
    if (!current || !brief.trim() || commandBusy) return;
    setCommandBusy(true);
    setBriefMessage(flowCopy.briefReading);
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
        setBriefMessage(flowCopy.briefFallback);
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
      setBriefMessage(flowCopy.briefReview);
    } catch {
      setBriefMessage(flowCopy.briefFallback);
    } finally {
      setCommandBusy(false);
    }
  }

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
  }, [basics, preferences, currentStep, readOnly]);

  useEffect(() => clearAutosaveTimer, []);

  if (viewState === "loading") return <SetupSkeleton />;
  if (viewState === "empty")
    return (
      <SetupState
        icon={<Sparkle aria-hidden="true" />}
        title={t("prototype.1d3ea9c7b9ef")}
        body={t("prototype.61806714c017")}
        action={
          <button onClick={() => void createDraft()}>
            {commandBusy ? t("prototype.c79ed9492e3c") : t("prototype.76e684d8787d")}
          </button>
        }
      />
    );
  if (viewState !== "ready" && viewState !== "read-only") {
    const copy = stateCopy[viewState];
    return (
      <SetupState
        icon={viewState === "offline" ? <CloudSlash aria-hidden="true" /> : <Warning aria-hidden="true" />}
        title={copy.title}
        body={copy.body}
        action={
          viewState === "conflict" ? (
            <button onClick={() => window.location.reload()}>{t("prototype.4b46950ea4dd")}</button>
          ) : null
        }
      />
    );
  }
  if (!setup) return null;

  const step = assistedSetupSteps[currentIndex] ?? assistedSetupSteps[0]!;
  const disabled = readOnly || commandBusy;
  return (
    <div className={styles.workspace} data-testid="phase4-assisted-setup">
      <aside className={styles.stepRail} aria-label={t("prototype.310d3ee8fdc8")}>
        <p>{t("prototype.fe48ad8a445f")}</p>
        <ol>
          {assistedSetupSteps.map((item, index) => {
            const completed = setup.completed_steps.includes(item.id);
            const reachable = index <= currentIndex || completed;
            return (
              <li key={item.id} data-current={item.id === currentStep} data-complete={completed}>
                <button
                  type="button"
                  onClick={() => void goTo(item.id)}
                  disabled={commandBusy || !reachable}
                >
                  <span>{completed ? <Check aria-hidden="true" /> : index + 1}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.short}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className={styles.railNote}>
          <Info aria-hidden="true" />
          <span>{t("prototype.7bb0248b8faa")}</span>
        </div>
      </aside>

      <section className={styles.main}>
        <div className={styles.mobileProgress} data-testid="setup-mobile-progress">
          <span>
            {t("prototype.8e6a6cca7aae")}
            {currentIndex + 1} {t("prototype.988a89fbb78c")}
          </span>
          <strong>{step.label}</strong>
          <progress
            value={currentIndex + 1}
            max={assistedSetupSteps.length}
            aria-label={t("prototype.e56312ff3945", { value1: currentIndex + 1 })}
          />
        </div>
        <header className={styles.heading}>
          <p>{step.short}</p>
          <h1 ref={headingRef} tabIndex={-1}>
            {stepTitle(currentStep)}
          </h1>
          <span>{stepIntro(currentStep)}</span>
        </header>

        {viewState === "read-only" ? (
          <div className={styles.banner} role="status">
            <ShieldCheck aria-hidden="true" />
            <span>{phase4SetupCopy.readOnly}</span>
          </div>
        ) : null}
        {currentErrors.length ? (
          <div className={styles.issueSummary} role="alert" tabIndex={-1}>
            <strong>{t("prototype.fc39364b6714")}</strong>
            <ul>
              {currentErrors.map((issue) => (
                <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={styles.stepBody}>
          {currentStep === "basics" && basics ? (
            <BasicsStep
              value={basics}
              onChange={setBasics}
              brief={brief}
              onBriefChange={setBrief}
              onConvert={() => void convertBrief()}
              briefMessage={briefMessage}
              missingFields={missingFields}
              disabled={disabled}
            />
          ) : null}
          {currentStep === "capacity" ? <CapacityStep setup={setup} competitionId={document.competitionId} /> : null}
          {currentStep === "settings" ? <SettingsStep setup={setup} competitionId={document.competitionId} /> : null}
          {currentStep === "entries" ? <EntriesStep setup={setup} competitionId={document.competitionId} /> : null}
          {currentStep === "format_preferences" && preferences ? (
            <PreferencesStep value={preferences} onChange={setPreferences} disabled={disabled} />
          ) : null}
          {currentStep === "format_recommendations" ? (
            <RecommendationStep
              setup={setup}
              disabled={disabled}
              onSelect={(id, acknowledged) => void selectRecommendation(id, acknowledged)}
            />
          ) : null}
          {currentStep === "schedule_review" ? (
            <ScheduleStep setup={setup} competitionId={document.competitionId} />
          ) : null}
          {currentStep === "review_publish" ? <ReviewStep setup={setup} /> : null}
        </div>

        <p className={styles.announcement} aria-live="polite">
          {autosaving ? phase4SetupCopy.saving : announcement}
        </p>
        <footer className={styles.actions}>
          <button
            className={styles.back}
            type="button"
            disabled={commandBusy || currentIndex === 0}
            onClick={() => void goTo(assistedSetupSteps[currentIndex - 1]!.id)}
          >
            <ArrowLeft aria-hidden="true" /> {t("prototype.76900f1bfd16")}
          </button>
          {currentIndex < assistedSetupSteps.length - 1 ? (
            <button
              className={styles.continue}
              type="button"
              disabled={disabled}
              onClick={() => void continueToNext()}
            >
              {commandBusy
                ? t("prototype.23e39291d613")
                : `${opaqueId("Continue to")} ${assistedSetupSteps[currentIndex + 1]!.label.toLowerCase()}`}
              <ArrowRight aria-hidden="true" />
            </button>
          ) : (
            <button
              className={styles.continue}
              type="button"
              disabled={disabled || !setup.values.review_publish}
              onClick={() => void completeSetup()}
            >
              {t("prototype.b649139b411b")}
              <ArrowRight aria-hidden="true" />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function BasicsStep({
  value,
  onChange,
  brief,
  onBriefChange,
  onConvert,
  briefMessage,
  missingFields,
  disabled,
}: {
  value: BasicsDraft;
  onChange(value: BasicsDraft): void;
  brief: string;
  onBriefChange(value: string): void;
  onConvert(): void;
  briefMessage: string;
  missingFields: readonly string[];
  disabled: boolean;
}) {
  const patch = (next: Partial<BasicsDraft>) => onChange({ ...value, ...next });
  return (
    <div className={styles.basicsLayout}>
      <section className={styles.aiBrief} aria-labelledby="brief-title">
        <MagicWand aria-hidden="true" />
        <div>
          <h2 id="brief-title">{t("prototype.456041ec5dc4")}</h2>
          <p>{t("prototype.629dbc233357")}</p>
          <label>
            <span>{t("prototype.900b492a66b7")}</span>
            <textarea
              value={brief}
              onChange={(event) => onBriefChange(event.target.value)}
              disabled={disabled}
              rows={4}
            />
            <small>{t("prototype.ec2e24035d4e")}</small>
          </label>
          <button type="button" onClick={onConvert} disabled={disabled || !brief.trim()}>
            <Sparkle aria-hidden="true" /> {t("prototype.cc5c27199110")}
          </button>
          <p className={styles.inlineStatus} aria-live="polite">
            {briefMessage}
          </p>
          {missingFields.length ? (
            <div className={styles.missingFields}>
              <strong>{t("prototype.b60de3ca37f2")}</strong>
              {missingFields.map((field) => (
                <a key={field} href={`#setup-${field.replaceAll(".", "-")}`}>
                  {field.replaceAll("_", " ")}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <div className={styles.fieldGrid}>
        <Field id="setup-name" label={t("prototype.f01e63d85488")} helper={t("prototype.0f7d370ba0b0")}>
          <input
            value={value.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-sport" label={t("prototype.9a085dd854f0")} helper={flowCopy.sportReset}>
          <select
            value={value.sport_code}
            onChange={(event) => patch({ sport_code: event.target.value as BasicsDraft["sport_code"] })}
            disabled={disabled}
          >
            <option value="canoe_polo">{t("prototype.a756edc241cb")}</option>
            <option value="badminton">{t("prototype.e29e9f9c8590")}</option>
            <option value="table_tennis">{t("prototype.16804d61fffc")}</option>
            <option value="volleyball">{t("prototype.cdf77e1365d8")}</option>
            <option value="basketball">{t("prototype.3530d1806b6a")}</option>
          </select>
        </Field>
        <Field id="setup-venue" label={t("prototype.aea1b15df626")}>
          <input
            value={value.location.venue}
            onChange={(event) => patch({ location: { ...value.location, venue: event.target.value } })}
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-address" label={t("prototype.56ef8f20955f")}>
          <input
            value={value.location.address}
            onChange={(event) => patch({ location: { ...value.location, address: event.target.value } })}
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-locality" label={flowCopy.locality}>
          <input
            value={value.location.locality ?? ""}
            onChange={(event) => patch({ location: { ...value.location, locality: event.target.value || null } })}
            disabled={disabled}
          />
        </Field>
        <Field id="setup-country-code" label={flowCopy.countryCode}>
          <input
            value={value.location.country_code}
            maxLength={2}
            onChange={(event) =>
              patch({ location: { ...value.location, country_code: event.target.value.toUpperCase() } })
            }
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-dates-start" label={t("prototype.642efcf146d1")}>
          <input
            type="date"
            value={value.starts_on}
            onChange={(event) => patch({ starts_on: event.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field id="setup-dates-end" label={t("prototype.bfd959895779")}>
          <input
            type="date"
            value={value.ends_on}
            onChange={(event) => patch({ ends_on: event.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field id="setup-time-zone" label={flowCopy.timezone}>
          <input
            value={value.time_zone}
            onChange={(event) => patch({ time_zone: event.target.value })}
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-locale" label={flowCopy.locale}>
          <input
            value={value.locale}
            onChange={(event) => patch({ locale: event.target.value })}
            disabled={disabled}
            required
          />
        </Field>
        <Field id="setup-entry-count" label={t("prototype.338ec01dd683")}>
          <input
            type="number"
            min={1}
            max={10000}
            value={value.entry_count}
            onChange={(event) => patch({ entry_count: Number(event.target.value) })}
            disabled={disabled}
          />
        </Field>
        <Field id="setup-division-count" label={t("prototype.442a06547692")}>
          <input
            type="number"
            min={1}
            max={1000}
            value={value.division_count}
            onChange={(event) => patch({ division_count: Number(event.target.value) })}
            disabled={disabled}
          />
        </Field>
        <Field id="setup-entry-status" label={flowCopy.entryStatus}>
          <select
            value={value.entry_count_status}
            onChange={(event) =>
              patch({ entry_count_status: event.target.value as BasicsDraft["entry_count_status"] })
            }
            disabled={disabled}
          >
            <option value="confirmed">{flowCopy.confirmed}</option>
            <option value="estimated">{flowCopy.estimated}</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function CapacityStep({ setup, competitionId }: { setup: Phase4SetupDocument; competitionId: string }) {
  const capacity = setup.values.capacity;
  if (!capacity)
    return (
      <InlineEmpty
        title={t("prototype.2a128415e1f7")}
        href={`/organiser/competitions/${competitionId}/capacity`}
        action={t("prototype.ba51c68bcb14")}
      />
    );
  return (
    <div className={styles.capacityLayout}>
      <div className={styles.referenceRows}>
        <ReferenceRow
          icon={<Gauge />}
          title={t("prototype.df884c89c2aa")}
          value={`${capacity.area_ids.length} ${opaqueId("active")}`}
          detail={t("prototype.88eb127a564b", { value1: capacity.revision })}
        />
        <ReferenceRow
          icon={<CalendarBlank />}
          title={t("prototype.87fa6aa6da2f")}
          value={String(capacity.effective.availableMatchSlots)}
          detail={`${capacity.effective.slotMinutes} ${opaqueId("minute slots in")} ${capacity.time_zone}`}
        />
        <ReferenceRow
          icon={<Warning />}
          title={t("prototype.b5437ca520c7")}
          value={String(capacity.effective.fixedReserveSlots)}
          detail={t("prototype.7b502daab9fd")}
        />
      </div>
      <aside className={styles.summaryRail}>
        <p>{t("prototype.dca7c2556933")}</p>
        <strong>{capacity.effective.availableMatchSlots}</strong>
        <span>{t("prototype.331e9627e66e")}</span>
        <dl>
          <div>
            <dt>{t("prototype.4850b174b713")}</dt>
            <dd>{capacity.effective.requiredMatchSlots}</dd>
          </div>
          <div>
            <dt>{t("prototype.5ae6f30c297b")}</dt>
            <dd>{capacity.effective.remainingMatchSlots}</dd>
          </div>
        </dl>
        <Link href={`/organiser/competitions/${competitionId}/capacity`}>
          {t("prototype.004fc43eeb38")}
          <ArrowRight />
        </Link>
      </aside>
    </div>
  );
}

function SettingsStep({ setup, competitionId }: { setup: Phase4SetupDocument; competitionId: string }) {
  const values = setup.values.settings ?? [];
  const sport = setup.values.basics ? setupSportLabel(setup.values.basics.sport_code) : opaqueId("Selected sport");
  if (!values.length)
    return (
      <InlineEmpty
        title={`${sport}: ${t("prototype.d8e0a929c304")}`}
        href={`/organiser/competitions/${competitionId}/settings`}
        action={t("prototype.4bfa5aa91923")}
      />
    );
  return (
    <div className={styles.referenceRows}>
      <ReferenceRow
        icon={<ShieldCheck />}
        title={`${sport} · ${flowCopy.canonicalRules}`}
        value={values.some((item) => item.mode === "customised") ? opaqueId("Customised") : opaqueId("Recommended")}
        detail={`${values.length} ${opaqueId("immutable settings references")}`}
      />
      {values.map((item) => (
        <ReferenceRow
          key={`${item.scope}:${item.division_id ?? "all"}`}
          icon={<ShieldCheck />}
          title={item.scope === "competition" ? opaqueId("Competition settings") : opaqueId("Division settings")}
          value={item.mode === "recommended" ? opaqueId("Recommended") : opaqueId("Customised")}
          detail={t("prototype.aa38f34342f1", { value1: item.settings_revision, value2: item.pack_version })}
        />
      ))}
      <Link className={styles.textLink} href={`/organiser/competitions/${competitionId}/settings`}>
        {t("prototype.d232bf04cb04")}
        <ArrowRight />
      </Link>
    </div>
  );
}

function EntriesStep({ setup, competitionId }: { setup: Phase4SetupDocument; competitionId: string }) {
  const entries = setup.values.entries;
  if (!entries)
    return (
      <InlineEmpty
        title={t("prototype.83e31700889c")}
        href={`/organiser/competitions/${competitionId}/entries`}
        action={t("prototype.a2cbc1322846")}
      />
    );
  return (
    <div className={styles.referenceRows}>
      <ReferenceRow
        icon={<UsersThree />}
        title={t("prototype.0845b2af1e78")}
        value={`${entries.total_entry_count} ${opaqueId("total")}`}
        detail={`${entries.divisions.length} ${opaqueId("divisions")} · ${entries.imports.length} ${opaqueId("imports")}`}
      />
      {entries.divisions.map((division, index) => (
        <ReferenceRow
          key={division.division_id}
          icon={<UsersThree />}
          title={t("prototype.c89fae5bc3d5", { value1: index + 1 })}
          value={`${division.confirmed_count} ${opaqueId("confirmed")}`}
          detail={`${division.placeholder_count} ${opaqueId("placeholders · revision")} ${division.division_revision}`}
        />
      ))}
      <Link className={styles.textLink} href={`/organiser/competitions/${competitionId}/entries`}>
        {t("prototype.cb41f0603778")}
        <ArrowRight />
      </Link>
    </div>
  );
}

function PreferencesStep({
  value,
  onChange,
  disabled,
}: {
  value: PreferencesDraft;
  onChange(value: PreferencesDraft): void;
  disabled: boolean;
}) {
  const toggle = (key: "ranking" | "knockout" | "placement" | "qualification", field: string, checked: boolean) =>
    onChange({ ...value, [key]: { ...value[key], [field]: checked } });
  return (
    <div className={styles.preferences}>
      <Field label={t("prototype.325eaefc3daf")} helper={t("prototype.10b678fb92e3")}>
        <input
          type="number"
          min={1}
          max={100}
          value={value.minimum_matches.per_entry}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, minimum_matches: { per_entry: Number(event.target.value) } })}
        />
      </Field>
      <fieldset>
        <legend>{t("prototype.75b063db3af7")}</legend>
        <CheckField
          label={t("prototype.f3b5604b4491")}
          checked={value.ranking.rank_all_entries}
          disabled={disabled}
          onChange={(checked) => toggle(opaqueId("ranking"), opaqueId("rank_all_entries"), checked)}
        />
        <CheckField
          label={t("prototype.ef99dd58f698")}
          checked={value.knockout.required}
          disabled={disabled}
          onChange={(checked) => toggle(opaqueId("knockout"), opaqueId("required"), checked)}
        />
        <CheckField
          label={t("prototype.8fa183fcdb36")}
          checked={value.placement.required}
          disabled={disabled}
          onChange={(checked) => toggle(opaqueId("placement"), opaqueId("required"), checked)}
        />
        <CheckField
          label={t("prototype.0776908af4e1")}
          checked={value.qualification.cross_group_allowed}
          disabled={disabled}
          onChange={(checked) => toggle(opaqueId("qualification"), opaqueId("cross_group_allowed"), checked)}
        />
      </fieldset>
      <fieldset>
        <legend>{t("prototype.6a72d069484d")}</legend>
        {([opaqueId("speed"), opaqueId("simplicity"), opaqueId("participation")] as const).map((priority) => (
          <label className={styles.radioRow} key={priority}>
            <input
              type="radio"
              name="priority"
              checked={value.priority.value === priority}
              disabled={disabled}
              onChange={() => onChange({ ...value, priority: { value: priority } })}
            />
            <span>
              <strong>{priority[0]!.toUpperCase() + priority.slice(1)}</strong>
              <small>
                {priority === "speed"
                  ? t("prototype.077e5c942bb4")
                  : priority === "simplicity"
                    ? t("prototype.92bd4efd1fa8")
                    : t("prototype.d7d3f2be1138")}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function RecommendationStep({
  setup,
  disabled,
  onSelect,
}: {
  setup: Phase4SetupDocument;
  disabled: boolean;
  onSelect(id: string, acknowledged: boolean): void;
}) {
  const selection = setup.values.format_recommendations;
  if (!selection)
    return (
      <InlineEmpty
        title={t("prototype.53bc35c2a593")}
        action={t("prototype.1a4c6ec15d6d")}
        href={`/organiser/competitions/${setup.competition_id}/format`}
      />
    );
  const candidates = [
    ...selection.recommendations,
    ...(selection.requires_changes ? [selection.requires_changes] : []),
  ];
  return (
    <div className={styles.recommendations}>
      {candidates.map((item) => {
        const selected = selection.selected_recommendation_id === item.id;
        const shortfall = item.capacity_status === "requires_changes";
        return (
          <article key={item.id} data-selected={selected} data-shortfall={shortfall}>
            <header>
              <span>{item.capacity_status.replaceAll("_", " ")}</span>
              <h2>{item.name}</h2>
              <p>{item.structure}</p>
            </header>
            <dl>
              <div>
                <dt>{t("prototype.98abff28a940")}</dt>
                <dd>{item.match_count}</dd>
              </div>
              <div>
                <dt>{t("prototype.a538b0ade6cc")}</dt>
                <dd>{item.minimum_matches_per_entry}</dd>
              </div>
              <div>
                <dt>{t("prototype.f4830a1dae29")}</dt>
                <dd>{item.scheduling_status.replaceAll("_", " ")}</dd>
              </div>
            </dl>
            <p>{item.advantage}</p>
            {item.warning_codes.length ? (
              <ul>
                {item.warning_codes.map((warning) => (
                  <li key={warning}>{warning.replaceAll("_", " ")}</li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              disabled={disabled || item.scheduling_status === "infeasible"}
              onClick={() => onSelect(item.id, shortfall)}
            >
              {selected ? (
                <>
                  <Check /> {t("prototype.57fd7a0cf33f")}
                </>
              ) : (
                t("prototype.c810c402a124")
              )}
            </button>
          </article>
        );
      })}
      <Link className={styles.textLink} href={`/organiser/competitions/${setup.competition_id}/format`}>
        {t("prototype.746de9bc4116")}
        <ArrowRight />
      </Link>
    </div>
  );
}

function ScheduleStep({ setup, competitionId }: { setup: Phase4SetupDocument; competitionId: string }) {
  const schedule = setup.values.schedule_review;
  if (!schedule)
    return (
      <InlineEmpty
        title={t("prototype.a2670ddaaf34")}
        href={`/organiser/competitions/${competitionId}/schedule`}
        action={t("prototype.afada2c12fa2")}
      />
    );
  return (
    <div className={styles.referenceRows}>
      <ReferenceRow
        icon={<CalendarBlank />}
        title={t("prototype.3019f5a09b8b")}
        value={schedule.objective.replace("_", " ")}
        detail={t("prototype.51be7b5a38e1", {
          value1: schedule.selected_result_revision,
          value2: schedule.feasibility,
        })}
      />
      <ReferenceRow
        icon={<ShieldCheck />}
        title={t("prototype.efc237c244e4")}
        value={`${opaqueId("Capacity r")}${schedule.capacity_revision}`}
        detail={`${schedule.settings_references.length} ${opaqueId("settings references")}`}
      />
      <Link className={styles.textLink} href={`/organiser/competitions/${competitionId}/schedule`}>
        {t("prototype.cb0bd0050851")}
        <ArrowRight />
      </Link>
    </div>
  );
}

function ReviewStep({ setup }: { setup: Phase4SetupDocument }) {
  const rows = assistedSetupSteps.slice(0, 7).map((step) => ({
    step,
    complete: setup.completed_steps.includes(step.id),
    issues: setup.steps.find((item) => item.id === step.id)?.errors ?? [],
  }));
  return (
    <div className={styles.review}>
      <ul>
        {rows.map(({ step, complete, issues }) => (
          <li key={step.id} data-ready={complete && !issues.length}>
            <span>{complete && !issues.length ? <Check /> : <Warning />}</span>
            <div>
              <strong>{step.label}</strong>
              <small>{issues[0]?.message ?? (complete ? t("prototype.6aa852ff8317") : t("prototype.07297fa94a99"))}</small>
            </div>
          </li>
        ))}
      </ul>
      <div className={styles.publicationNote}>
        <ShieldCheck />
        <div>
          <h2>{t("prototype.6413e1fc2e93")}</h2>
          <p>{t("prototype.d7bdb5899f10")}</p>
        </div>
      </div>
    </div>
  );
}

function ReferenceRow({
  icon,
  title,
  value,
  detail,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.referenceRow}>
      <span aria-hidden="true">{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <b>{value}</b>
    </div>
  );
}

function CheckField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className={styles.checkRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Field({
  id,
  label,
  helper,
  children,
}: {
  id?: string;
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <label id={id} className={styles.field}>
      <span>{label}</span>
      {children}
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

function InlineEmpty({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <div className={styles.inlineEmpty}>
      <Info />
      <h2>{title}</h2>
      <p>{t("prototype.aa2bdd7e6e23")}</p>
      <Link href={href}>
        {action}
        <ArrowRight />
      </Link>
    </div>
  );
}

function SetupState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className={styles.state}>
      <span>{icon}</span>
      <h1>{title}</h1>
      <p>{body}</p>
      {action}
    </section>
  );
}

function SetupSkeleton() {
  return (
    <div className={styles.skeleton} aria-label={t("prototype.70dd2f18c378")}>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stepTitle(step: Phase4SetupStepId) {
  return (
    {
      basics: opaqueId("Tell us about the competition"),
      capacity: opaqueId("Set the event capacity"),
      settings: opaqueId("Confirm the sport-specific settings"),
      entries: opaqueId("Link divisions and entries"),
      format_preferences: opaqueId("Choose what the format should optimise"),
      format_recommendations: opaqueId("Select a feasible format"),
      schedule_review: opaqueId("Review a schedule alternative"),
      review_publish: opaqueId("Review and publish"),
    } as const
  )[step];
}

function stepIntro(step: Phase4SetupStepId) {
  return (
    {
      basics: opaqueId(
        "Start with deterministic fields. The selected sport pins its own versioned settings pack and schedule defaults.",
      ),
      capacity: opaqueId("Authoritative playing-area availability is calculated by the capacity service."),
      settings: opaqueId("The settings shown here come from the selected sport and are immutable revision references."),
      entries: opaqueId("Validated imports and entry revisions are referenced without copying sensitive source rows."),
      format_preferences: opaqueId("Six explicit preference groups drive the deterministic recommendation engine."),
      format_recommendations: opaqueId(
        "Choose from at most three meaningfully different options. Capacity changes are explicit.",
      ),
      schedule_review: opaqueId("Compare named quality components before selecting a schedule revision."),
      review_publish: opaqueId("Nothing becomes public until the organiser confirms the exact pinned evidence."),
    } as const
  )[step];
}
