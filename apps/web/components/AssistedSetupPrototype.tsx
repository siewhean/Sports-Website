"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  Check,
  ClipboardText,
  CloudSlash,
  Clock,
  MapPin,
  Plus,
  Sparkle,
  UploadSimple,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import { opaqueId, translate as t } from "@matchday/ui";
import {
  ASSISTED_SETUP_DRAFT_KEY,
  ASSISTED_SETUP_DRAFT_VERSION,
  estimateMatches,
  parseAssistedSetupDraft,
  type AssistedSetupDraft,
  type RecommendationId,
} from "@/lib/assisted-setup";
import styles from "./AssistedSetupPrototype.module.css";
import { cssModuleClasses as cx } from "./prototype/cssModuleClasses";
import primitiveStyles from "./prototype/PrototypePrimitives.module.css";

const componentStyles = { ...primitiveStyles, ...styles };

const steps = [
  [t("prototype.8fdd2ee8475e"), t("prototype.b72e5a6a46a1")],
  [t("prototype.ae65d096550f"), t("prototype.87fa6aa6da2f")],
  [t("prototype.74a883a037bc"), t("prototype.435ec38b6809")],
  [t("prototype.7cb76b4af12a"), t("prototype.5817d4d8af41")],
  [t("prototype.66962f72a088"), t("prototype.0c6b238fff63")],
  [t("prototype.0738ee00b61b"), t("prototype.080ecce40973")],
  [t("prototype.f4830a1dae29"), t("prototype.cba50b11ac7c")],
  [t("prototype.a713d3656284"), t("prototype.5f215a565c3f")],
] as const;

type DemoState = "ready" | "loading" | "error" | "offline";
type SetupErrors = Partial<
  Record<
    | "competitionName"
    | "startDate"
    | "endDate"
    | "venue"
    | "teams"
    | "divisions"
    | "areas"
    | "days"
    | "availability"
    | "recommendation"
    | "capacityAcknowledgement"
    | "schedule",
    string
  >
>;

const demoStates = [
  { id: "ready", label: t("prototype.b24d6d33736e") },
  { id: "loading", label: t("prototype.b4a070a2d341") },
  { id: "error", label: t("prototype.ca00fccfb408") },
  { id: "offline", label: t("prototype.8e2c7ac50813") },
] as const;

const entryMethods = [
  { id: "manual", label: t("prototype.36bde66f289a") },
  { id: "paste", label: t("prototype.a2c183d5a12a") },
  { id: "import", label: t("prototype.d942f6488657") },
] as const;

const setupErrorIds = {
  competitionName: opaqueId("competition-name-error"),
  startDate: opaqueId("start-date-error"),
  endDate: opaqueId("end-date-error"),
  venue: opaqueId("venue-error"),
  teams: opaqueId("teams-error"),
  divisions: opaqueId("divisions-error"),
  areas: opaqueId("areas-error"),
} as const;

export function AssistedSetupPrototype() {
  const [activeStep, setActiveStep] = useState(0);
  const [demoState, setDemoState] = useState<DemoState>(opaqueId("ready"));
  const [competitionName, setCompetitionName] = useState(t("prototype.f2243ff3e203"));
  const [startDate, setStartDate] = useState("2026-08-14");
  const [endDate, setEndDate] = useState("2026-08-16");
  const [venue, setVenue] = useState(t("prototype.707afb8bc084"));
  const [teams, setTeams] = useState(8);
  const [divisions, setDivisions] = useState(1);
  const [areas, setAreas] = useState(2);
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [days, setDays] = useState([
    { label: t("prototype.dbe35c7363c2"), opening: "08:00", closing: "18:00" },
    { label: t("prototype.873fef760e5d"), opening: "08:00", closing: "16:00" },
  ]);
  const [areaAvailability, setAreaAvailability] = useState<string[]>([opaqueId("full"), opaqueId("full")]);
  const [unavailableMinutes, setUnavailableMinutes] = useState(60);
  const [settingsMode, setSettingsMode] = useState<"recommended" | "customised">(opaqueId("recommended"));
  const [recommendation, setRecommendation] = useState<RecommendationId>(opaqueId("balanced"));
  const [schedule, setSchedule] = useState<"fastest" | "balanced" | "rest">(opaqueId("balanced"));
  const [errors, setErrors] = useState<SetupErrors>({});
  const [acknowledgedCapacitySignature, setAcknowledgedCapacitySignature] = useState<string | null>(null);
  const [resumedDraft, setResumedDraft] = useState(false);
  const draftLoadedRef = useRef(false);
  const activeStepRef = useRef(activeStep);
  const historyDepthRef = useRef(0);
  const nextLockedRef = useRef(false);
  const operatingMinutes = useMemo(
    () => days.reduce((total, day) => total + minutesBetween(day.opening, day.closing), 0),
    [days],
  );
  const availableAreaFactor = useMemo(
    () =>
      Array.from(
        { length: Number.isInteger(areas) && areas > 0 && areas <= 64 ? areas : 0 },
        (_, index) => areaAvailability[index] ?? "full",
      ).reduce(
        (total, availability) => total + (availability === "full" ? 1 : availability === "limited" ? 0.5 : 0),
        0,
      ),
    [areaAvailability, areas],
  );
  const slots = useMemo(
    () => Math.floor(Math.max(0, operatingMinutes * availableAreaFactor - unavailableMinutes) / slotMinutes),
    [availableAreaFactor, operatingMinutes, slotMinutes, unavailableMinutes],
  );
  const recommendationEstimates = useMemo(
    () => ({
      fast: estimateMatches(teams, divisions, opaqueId("fast")),
      balanced: estimateMatches(teams, divisions, opaqueId("balanced")),
      depth: estimateMatches(teams, divisions, opaqueId("depth")),
    }),
    [divisions, teams],
  );
  const estimatedMatches = recommendationEstimates[recommendation];
  const reserve = slots - estimatedMatches;
  const capacitySignature = `${slots}:${estimatedMatches}`;
  const capacityAcknowledged = acknowledgedCapacitySignature === capacitySignature;

  useEffect(() => {
    activeStepRef.current = activeStep;
  }, [activeStep]);

  useEffect(() => {
    let rawDraft: string | null = null;
    try {
      rawDraft = window.localStorage.getItem(ASSISTED_SETUP_DRAFT_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browsing contexts.
    }
    const draft = parseAssistedSetupDraft(rawDraft);
    let cancelled = false;
    window.queueMicrotask(() => {
      if (cancelled) return;
      if (draft) {
        setActiveStep(draft.activeStep);
        setCompetitionName(draft.competitionName);
        setStartDate(draft.startDate);
        setEndDate(draft.endDate);
        setVenue(draft.venue);
        setTeams(draft.teams);
        setDivisions(draft.divisions);
        setAreas(draft.areas);
        setSlotMinutes(draft.slotMinutes);
        setDays(draft.days.map((day) => ({ ...day })));
        setAreaAvailability([...draft.areaAvailability]);
        setUnavailableMinutes(draft.unavailableMinutes);
        setSettingsMode(draft.settingsMode);
        setRecommendation(draft.recommendation);
        setSchedule(draft.schedule);
        setResumedDraft(true);
      }
      const initialStep = draft?.activeStep ?? 0;
      window.history.replaceState(
        { ...window.history.state, assistedSetupStep: initialStep, assistedSetupDepth: 0 },
        "",
        window.location.href,
      );
      draftLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!draftLoadedRef.current) return;
    const draft: AssistedSetupDraft = {
      version: ASSISTED_SETUP_DRAFT_VERSION,
      savedAt: Date.now(),
      activeStep,
      competitionName: competitionName.slice(0, 120),
      startDate,
      endDate,
      venue: venue.slice(0, 160),
      teams,
      divisions,
      areas,
      slotMinutes,
      days,
      areaAvailability: areaAvailability.filter(
        (value): value is "full" | "limited" | "unavailable" =>
          value === "full" || value === "limited" || value === "unavailable",
      ),
      unavailableMinutes,
      settingsMode,
      recommendation,
      schedule,
    };
    try {
      window.localStorage.setItem(ASSISTED_SETUP_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // The setup remains usable when storage is unavailable or full.
    }
  }, [
    activeStep,
    areaAvailability,
    areas,
    competitionName,
    days,
    divisions,
    endDate,
    recommendation,
    schedule,
    settingsMode,
    slotMinutes,
    startDate,
    teams,
    unavailableMinutes,
    venue,
  ]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const historyStep = (event.state as { assistedSetupStep?: unknown } | null)?.assistedSetupStep;
      const historyDepth = (event.state as { assistedSetupDepth?: unknown } | null)?.assistedSetupDepth;
      if (
        typeof historyStep === "number" &&
        Number.isInteger(historyStep) &&
        historyStep >= 0 &&
        historyStep < steps.length
      ) {
        historyDepthRef.current =
          typeof historyDepth === "number" && Number.isInteger(historyDepth) && historyDepth >= 0 ? historyDepth : 0;
        setErrors({});
        setActiveStep(historyStep);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const validateStep = useCallback(
    (step: number): SetupErrors => {
      const nextErrors: SetupErrors = {};
      if (step === 0) {
        if (!competitionName.trim()) nextErrors.competitionName = t("prototype.d3da63000f78");
        if (!startDate) nextErrors.startDate = t("prototype.f827710c5e92");
        if (!endDate) nextErrors.endDate = t("prototype.742603a2e49c");
        if (startDate && endDate && endDate < startDate) nextErrors.endDate = t("prototype.c6adcc8cffcf");
        if (!venue.trim()) nextErrors.venue = t("prototype.6e9f47b56118");
        if (!Number.isInteger(teams) || teams < 2) nextErrors.teams = t("prototype.074472b65934");
        else if (teams > 512) nextErrors.teams = t("prototype.5a0700a89f63");
        if (!Number.isInteger(divisions) || divisions < 1) nextErrors.divisions = t("prototype.5319e3366be5");
        else if (Number.isInteger(teams) && divisions > Math.floor(teams / 2))
          nextErrors.divisions = t("prototype.4630bfad7a28");
      }
      if (step === 1) {
        if (!Number.isInteger(areas) || areas < 1) nextErrors.areas = t("prototype.d8416abae639");
        else if (areas > 64) nextErrors.areas = t("prototype.d5be339ca588");
        if (days.some((day) => !day.opening || !day.closing || minutesBetween(day.opening, day.closing) <= 0)) {
          nextErrors.days = t("prototype.59290d6c8d90");
        }
        if (availableAreaFactor <= 0) nextErrors.availability = t("prototype.0ce626692ac9");
      }
      if (step === 5) {
        if (!recommendation) nextErrors.recommendation = t("prototype.580708293460");
        if (reserve < 0 && !capacityAcknowledged) {
          nextErrors.capacityAcknowledgement = t("prototype.a6bc2e22df16");
        }
      }
      if (step === 6 && !schedule) nextErrors.schedule = t("prototype.ab36ed16b141");
      return nextErrors;
    },
    [
      areas,
      availableAreaFactor,
      capacityAcknowledged,
      competitionName,
      days,
      divisions,
      endDate,
      recommendation,
      reserve,
      schedule,
      startDate,
      teams,
      venue,
    ],
  );

  const focusFirstError = () => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-setup-error='true']")?.focus();
    });
  };

  const navigateToStep = (targetStep: number) => {
    const boundedTarget = Math.min(Math.max(targetStep, 0), steps.length - 1);
    if (boundedTarget > activeStepRef.current) {
      for (let step = activeStepRef.current; step < boundedTarget; step += 1) {
        const stepErrors = validateStep(step);
        if (Object.keys(stepErrors).length > 0) {
          setErrors(stepErrors);
          focusFirstError();
          return false;
        }
      }
    }
    setErrors({});
    setActiveStep(boundedTarget);
    historyDepthRef.current += 1;
    const historyState = {
      ...window.history.state,
      assistedSetupStep: boundedTarget,
      assistedSetupDepth: historyDepthRef.current,
    };
    window.history.pushState(historyState, "", window.location.href);
    return true;
  };

  const next = () => {
    if (nextLockedRef.current) return;
    if (!navigateToStep(activeStep + 1)) return;
    nextLockedRef.current = true;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        nextLockedRef.current = false;
      });
    });
  };
  const back = () => {
    if (historyDepthRef.current > 0) window.history.back();
    else navigateToStep(activeStep - 1);
  };

  const discardDraft = () => {
    try {
      window.localStorage.removeItem(ASSISTED_SETUP_DRAFT_KEY);
    } catch {
      // No-op when browser storage is unavailable.
    }
    setResumedDraft(false);
  };

  return (
    <div className={cx(componentStyles, "setup-workspace")}>
      <aside className={cx(componentStyles, "setup-rail")} aria-label={t("prototype.310d3ee8fdc8")}>
        <p className={cx(componentStyles, "eyebrow")}>{t("prototype.04fc49e4f20d")}</p>
        <h1>
          {t("prototype.860fd2679e9d")}
          <br />
          {t("prototype.f3ad8fc95ff2")}
        </h1>
        <ol>
          {steps.map(([label, description], index) => (
            <li
              key={label}
              className={cx(
                componentStyles,
                index === activeStep ? "is-current" : index < activeStep ? "is-complete" : "",
              )}
            >
              <button
                type="button"
                onClick={() => navigateToStep(index)}
                aria-current={index === activeStep ? "step" : undefined}
              >
                <span className={cx(componentStyles, "step-marker")} aria-hidden="true">
                  {index < activeStep ? <Check weight="bold" /> : index + 1}
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className={cx(componentStyles, "setup-main")}>
        <div className={cx(componentStyles, "mobile-step-status")}>
          <span>
            {t("prototype.8e6a6cca7aae")} {activeStep + 1} {t("prototype.28391d3bc64e")} {steps.length}
          </span>
          <strong>{steps[activeStep][0]}</strong>
          <div>
            <span style={{ width: `${((activeStep + 1) / steps.length) * 100}%` }} />
          </div>
        </div>

        <div className={cx(componentStyles, "setup-command-row")}>
          <div>
            <p className={cx(componentStyles, "eyebrow")}>
              {t("prototype.a002e5f15ddb")} {activeStep + 1}
            </p>
            <h2>{steps[activeStep][0]}</h2>
            <p>{steps[activeStep][1]}</p>
          </div>
          <fieldset className={cx(componentStyles, "state-switcher")}>
            <legend>{t("prototype.a19e21c7cc69")}</legend>
            {demoStates.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={demoState === id} onClick={() => setDemoState(id)}>
                {label}
              </button>
            ))}
          </fieldset>
        </div>

        {resumedDraft && (
          <div className={cx(componentStyles, `${styles.draftNotice} status-banner`)} role="status">
            <ClipboardText />
            <span>
              <strong>{t("prototype.a82605a58d4d")}</strong>
              {t("prototype.09a4c7422e52")}
            </span>
            <button type="button" className={primitiveStyles.textButton} onClick={discardDraft}>
              {t("prototype.90e2699be213")}
            </button>
          </div>
        )}

        {Object.keys(errors).length > 0 && (
          <div className={cx(componentStyles, "status-banner is-error")} role="alert">
            <Warning />
            <span>
              <strong>{t("prototype.6316cca35738")}</strong>
              {t("prototype.d21bff117e8e")}
            </span>
          </div>
        )}

        {demoState === "offline" && (
          <div className={cx(componentStyles, "status-banner is-warning")} role="status">
            <CloudSlash />
            <span>
              <strong>{t("prototype.499e77ff4387")}</strong>
              {t("prototype.4833f0bcb44c")}
            </span>
          </div>
        )}
        {demoState === "error" && (
          <div className={cx(componentStyles, "status-banner is-error")} role="alert">
            <Warning />
            <span>
              <strong>{t("prototype.d1b92dad2484")}</strong>
              {t("prototype.c02e18dc6173")}
            </span>
          </div>
        )}

        {demoState === "loading" ? (
          <LoadingForm />
        ) : (
          <div className={cx(componentStyles, "setup-content")}>
            <div className={cx(componentStyles, "setup-form-column")}>
              {activeStep === 0 && (
                <BasicsStep
                  name={competitionName}
                  setName={setCompetitionName}
                  startDate={startDate}
                  setStartDate={setStartDate}
                  endDate={endDate}
                  setEndDate={setEndDate}
                  venue={venue}
                  setVenue={setVenue}
                  teams={teams}
                  setTeams={setTeams}
                  divisions={divisions}
                  setDivisions={setDivisions}
                  errors={errors}
                  demoError={demoState === "error"}
                />
              )}
              {activeStep === 1 && (
                <CapacityStep
                  areas={areas}
                  setAreas={setAreas}
                  days={days}
                  setDays={setDays}
                  areaAvailability={areaAvailability}
                  setAreaAvailability={setAreaAvailability}
                  unavailableMinutes={unavailableMinutes}
                  setUnavailableMinutes={setUnavailableMinutes}
                  slotMinutes={slotMinutes}
                  setSlotMinutes={setSlotMinutes}
                  errors={errors}
                />
              )}
              {activeStep === 2 && <SettingsStep mode={settingsMode} setMode={setSettingsMode} />}
              {activeStep === 3 && <EntriesStep />}
              {activeStep === 4 && <PreferencesStep />}
              {activeStep === 5 && (
                <RecommendationsStep
                  selected={recommendation}
                  setSelected={setRecommendation}
                  estimates={recommendationEstimates}
                  teams={teams}
                  divisions={divisions}
                  slotMinutes={slotMinutes}
                  reserve={reserve}
                  capacityAcknowledged={capacityAcknowledged}
                  setCapacityAcknowledged={(acknowledged) =>
                    setAcknowledgedCapacitySignature(acknowledged ? capacitySignature : null)
                  }
                  error={errors.capacityAcknowledgement ?? errors.recommendation}
                />
              )}
              {activeStep === 6 && (
                <ScheduleStep selected={schedule} setSelected={setSchedule} error={errors.schedule} />
              )}
              {activeStep === 7 && (
                <ReviewStep
                  offline={demoState === "offline"}
                  estimatedMatches={estimatedMatches}
                  slots={slots}
                  reserve={reserve}
                />
              )}
            </div>

            <aside className={cx(componentStyles, "capacity-summary")} aria-live="polite">
              <div className={cx(componentStyles, "summary-heading")}>
                <span>
                  <Sparkle weight="fill" />
                </span>
                <div>
                  <p className={cx(componentStyles, "eyebrow")}>{t("prototype.f3a7f33de50d")}</p>
                  <h3>
                    {slots} {t("prototype.6704807abaea")}
                  </h3>
                </div>
              </div>
              <dl>
                <div>
                  <dt>{t("prototype.df884c89c2aa")}</dt>
                  <dd>{areas}</dd>
                </div>
                <div>
                  <dt>{t("prototype.4419f6bc4286")}</dt>
                  <dd>{formatHours(operatingMinutes)}</dd>
                </div>
                <div>
                  <dt>{t("prototype.ca1844969742")}</dt>
                  <dd>
                    {unavailableMinutes}
                    {t("prototype.62c66a7a5dd7")}
                  </dd>
                </div>
                <div>
                  <dt>{t("prototype.59dee41e9a3e")}</dt>
                  <dd>
                    {slotMinutes}
                    {t("prototype.62c66a7a5dd7")}
                  </dd>
                </div>
                <div>
                  <dt>{t("prototype.4068e7b82c36")}</dt>
                  <dd>{estimatedMatches}</dd>
                </div>
              </dl>
              <div className={cx(componentStyles, `capacity-meter${reserve < 0 ? " is-over" : ""}`)}>
                <span style={{ width: `${Math.min(100, (estimatedMatches / Math.max(1, slots)) * 100)}%` }} />
              </div>
              <p className={cx(componentStyles, reserve < 0 ? "danger-text" : "success-text")}>
                {reserve < 0 ? (
                  <>
                    <Warning /> {t("prototype.0e96950aeb59")} {Math.abs(reserve)} {t("prototype.3b478a0a3fc6")}
                  </>
                ) : (
                  <>
                    <Check /> {reserve} {t("prototype.a1c620bead06")}
                  </>
                )}
              </p>
              <small>
                {t("prototype.6483a855b640")}.{" "}
                {t("prototype.5e7c14e47e81", { teams, divisionLabel: formatDivisionCount(divisions) })}{" "}
                {t("prototype.e14e8b99db9e")}
              </small>
            </aside>
          </div>
        )}

        <footer className={cx(componentStyles, "setup-actions")}>
          <button
            className={cx(componentStyles, "button secondary")}
            type="button"
            onClick={back}
            disabled={activeStep === 0}
          >
            <ArrowLeft />
            {t("prototype.76900f1bfd16")}
          </button>
          <p>
            {t("prototype.ea2c9daa1a05")} <span aria-hidden="true">·</span>{" "}
            {competitionName || t("prototype.5a8f60f15a00")}
          </p>
          {activeStep < steps.length - 1 ? (
            <button className={cx(componentStyles, "button primary")} type="button" onClick={next}>
              {t("prototype.31fbef162594")}
              <ArrowRight />
            </button>
          ) : (
            <button className={cx(componentStyles, "button primary")} type="button" disabled={demoState === "offline"}>
              {t("prototype.b649139b411b")}
              <ArrowRight />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function BasicsStep({
  name,
  setName,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  venue,
  setVenue,
  teams,
  setTeams,
  divisions,
  setDivisions,
  errors,
  demoError,
}: {
  name: string;
  setName: (value: string) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  endDate: string;
  setEndDate: (value: string) => void;
  venue: string;
  setVenue: (value: string) => void;
  teams: number;
  setTeams: (value: number) => void;
  divisions: number;
  setDivisions: (value: number) => void;
  errors: SetupErrors;
  demoError: boolean;
}) {
  return (
    <div className={cx(componentStyles, "form-stack")} data-setup-step="0">
      <Field
        label={t("prototype.f01e63d85488")}
        hint={t("prototype.b6d78c4e2099")}
        error={errors.competitionName}
        messageId={setupErrorIds.competitionName}
        wide
      >
        <input
          id="competition-name"
          aria-label={t("prototype.f01e63d85488")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={Boolean(errors.competitionName)}
          aria-describedby={errors.competitionName ? setupErrorIds.competitionName : undefined}
          data-setup-error={errors.competitionName ? "true" : undefined}
        />
      </Field>
      <div className={cx(componentStyles, "form-grid")}>
        <Field label={t("prototype.9a085dd854f0")}>
          <select defaultValue={opaqueId("canoe")}>
            <option value="canoe">{t("prototype.a756edc241cb")}</option>
            <option>{t("prototype.e29e9f9c8590")}</option>
            <option>{t("prototype.16804d61fffc")}</option>
          </select>
        </Field>
        <Field label={t("prototype.4ceca1d52ced")}>
          <select defaultValue={opaqueId("sg")}>
            <option value="sg">{t("prototype.4b773e48c663")}</option>
            <option>{t("prototype.b27b602aa501")}</option>
          </select>
        </Field>
        <Field
          label={t("prototype.8169693101a4")}
          error={errors.startDate ?? (demoError ? t("prototype.0c94d3249833") : undefined)}
          messageId={setupErrorIds.startDate}
        >
          <span className={cx(componentStyles, "input-with-icon")}>
            <CalendarBlank />
            <input
              id="start-date"
              aria-label={t("prototype.8169693101a4")}
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              aria-invalid={Boolean(errors.startDate || demoError)}
              aria-describedby={errors.startDate || demoError ? setupErrorIds.startDate : undefined}
              data-setup-error={errors.startDate ? "true" : undefined}
            />
          </span>
        </Field>
        <Field label={t("prototype.14303aa0c4a0")} error={errors.endDate} messageId={setupErrorIds.endDate}>
          <span className={cx(componentStyles, "input-with-icon")}>
            <CalendarBlank />
            <input
              id="end-date"
              aria-label={t("prototype.14303aa0c4a0")}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              aria-invalid={Boolean(errors.endDate)}
              aria-describedby={errors.endDate ? setupErrorIds.endDate : undefined}
              data-setup-error={errors.endDate ? "true" : undefined}
            />
          </span>
        </Field>
        <Field label={t("prototype.15b61974b270")} error={errors.venue} messageId={setupErrorIds.venue}>
          <span className={cx(componentStyles, "input-with-icon")}>
            <MapPin />
            <input
              id="venue"
              aria-label={t("prototype.15b61974b270")}
              value={venue}
              onChange={(event) => setVenue(event.target.value)}
              aria-invalid={Boolean(errors.venue)}
              aria-describedby={errors.venue ? setupErrorIds.venue : undefined}
              data-setup-error={errors.venue ? "true" : undefined}
            />
          </span>
        </Field>
        <Field label={t("prototype.55e12bcd64b4")} error={errors.teams} messageId={setupErrorIds.teams}>
          <input
            id="teams"
            aria-label={t("prototype.55e12bcd64b4")}
            type="number"
            min="2"
            max="512"
            value={teams}
            onChange={(event) => setTeams(Number(event.target.value))}
            aria-invalid={Boolean(errors.teams)}
            aria-describedby={errors.teams ? setupErrorIds.teams : undefined}
            data-setup-error={errors.teams ? "true" : undefined}
          />
        </Field>
        <Field label={t("prototype.442a06547692")} error={errors.divisions} messageId={setupErrorIds.divisions}>
          <input
            id="divisions"
            aria-label={t("prototype.442a06547692")}
            type="number"
            min="1"
            max={Math.max(1, Math.floor(teams / 2))}
            value={divisions}
            onChange={(event) => setDivisions(Number(event.target.value))}
            aria-invalid={Boolean(errors.divisions)}
            aria-describedby={errors.divisions ? setupErrorIds.divisions : undefined}
            data-setup-error={errors.divisions ? "true" : undefined}
          />
        </Field>
      </div>
      <fieldset className={cx(componentStyles, "entry-confidence")}>
        <legend>{t("prototype.bf0614455bce")}</legend>
        <label>
          <input type="radio" name="entry-status" value="confirmed" />
          <span>
            <strong>{t("prototype.fe00b67b6dd1")}</strong>
            <small>{t("prototype.36db6ab0c444")}</small>
          </span>
        </label>
        <label>
          <input type="radio" name="entry-status" value="estimated" defaultChecked />
          <span>
            <strong>{t("prototype.b774599a9cd1")}</strong>
            <small>{t("prototype.f97b65b534c2")}</small>
          </span>
        </label>
      </fieldset>
    </div>
  );
}

function CapacityStep({
  areas,
  setAreas,
  days,
  setDays,
  areaAvailability,
  setAreaAvailability,
  unavailableMinutes,
  setUnavailableMinutes,
  slotMinutes,
  setSlotMinutes,
  errors,
}: {
  areas: number;
  setAreas: (value: number) => void;
  days: Array<{ label: string; opening: string; closing: string }>;
  setDays: React.Dispatch<React.SetStateAction<Array<{ label: string; opening: string; closing: string }>>>;
  areaAvailability: string[];
  setAreaAvailability: React.Dispatch<React.SetStateAction<string[]>>;
  unavailableMinutes: number;
  setUnavailableMinutes: (value: number) => void;
  slotMinutes: number;
  setSlotMinutes: (value: number) => void;
  errors: SetupErrors;
}) {
  const updateDay = (index: number, field: "opening" | "closing", value: string) =>
    setDays((current) => current.map((day, dayIndex) => (dayIndex === index ? { ...day, [field]: value } : day)));
  const updateArea = (index: number, value: string) =>
    setAreaAvailability((current) =>
      Array.from({ length: Math.min(64, Math.max(0, areas, current.length)) }, (_, areaIndex) =>
        areaIndex === index ? value : (current[areaIndex] ?? "full"),
      ),
    );
  return (
    <div className={cx(componentStyles, "form-stack")} data-setup-step="1">
      <div className={cx(componentStyles, "instruction")}>
        <Clock />
        <span>
          <strong>{t("prototype.9a0f3ed545c8")}</strong> {t("prototype.ccfd0e624aed")}
        </span>
      </div>
      <div className={cx(componentStyles, "form-grid")}>
        <Field
          label={t("prototype.df884c89c2aa")}
          hint={t("prototype.bc853d6d7b23")}
          error={errors.areas}
          messageId={setupErrorIds.areas}
        >
          <input
            type="number"
            min="1"
            max="64"
            value={areas}
            onChange={(event) => setAreas(Number(event.target.value))}
            aria-invalid={Boolean(errors.areas)}
            aria-describedby={errors.areas ? setupErrorIds.areas : undefined}
            data-setup-error={errors.areas ? "true" : undefined}
          />
        </Field>
        <Field label={t("prototype.c8235850262a")}>
          <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
            <option value="20">{t("prototype.cd04501cb57e")}</option>
            <option value="30">{t("prototype.a8ab14dc6126")}</option>
            <option value="40">{t("prototype.a5d3a8e3c12d")}</option>
            <option value="45">{t("prototype.bc54807d7df5")}</option>
          </select>
        </Field>
      </div>
      <section className={cx(componentStyles, "capacity-detail-section")} aria-labelledby="daily-windows-heading">
        <div className={cx(componentStyles, "section-heading")}>
          <div>
            <p className={cx(componentStyles, "eyebrow")}>{t("prototype.5b9e193b00e5")}</p>
            <h3 id="daily-windows-heading">{t("prototype.78559671f1d3")}</h3>
          </div>
          <small>{t("prototype.7db951f428f1")}</small>
        </div>
        <div className={cx(componentStyles, "daily-window-list")}>
          {days.map((day, index) => (
            <div key={day.label}>
              <strong>{day.label}</strong>
              <label>
                {day.label} {t("prototype.5d67709d42a8")}
                <input
                  type="time"
                  value={day.opening}
                  onChange={(event) => updateDay(index, opaqueId("opening"), event.target.value)}
                  aria-invalid={Boolean(errors.days)}
                  aria-describedby={errors.days ? "daily-windows-error" : undefined}
                  data-setup-error={errors.days && index === 0 ? "true" : undefined}
                />
              </label>
              <span aria-hidden="true">{t("prototype.663ea1bfffe5")}</span>
              <label>
                {day.label} {t("prototype.f7a7338feea1")}
                <input
                  type="time"
                  value={day.closing}
                  onChange={(event) => updateDay(index, opaqueId("closing"), event.target.value)}
                  aria-invalid={Boolean(errors.days)}
                  aria-describedby={errors.days ? "daily-windows-error" : undefined}
                />
              </label>
            </div>
          ))}
        </div>
        {errors.days && (
          <small id="daily-windows-error" className={cx(componentStyles, `field-error ${styles.fieldError}`)}>
            <Warning />
            {errors.days}
          </small>
        )}
      </section>
      <section className={cx(componentStyles, "capacity-detail-section")} aria-labelledby="area-availability-heading">
        <div className={cx(componentStyles, "section-heading")}>
          <div>
            <p className={cx(componentStyles, "eyebrow")}>{t("prototype.b8d7163c1c96")}</p>
            <h3 id="area-availability-heading">{t("prototype.45bb1bac6594")}</h3>
          </div>
          <small>{t("prototype.1933127c27d5")}</small>
        </div>
        <div className={cx(componentStyles, "area-availability-list")}>
          {Array.from({ length: Number.isInteger(areas) && areas > 0 && areas <= 64 ? areas : 0 }, (_, index) => (
            <label key={index}>
              <span>
                <strong>
                  {t("prototype.9a4fb762ae1b")} {index + 1}
                </strong>
                <small>{t("prototype.7665f9fc89d8")}</small>
              </span>
              <select
                aria-label={t("prototype.ba8434f2ac3e", { number: index + 1 })}
                value={areaAvailability[index] ?? "full"}
                onChange={(event) => updateArea(index, event.target.value)}
                aria-invalid={Boolean(errors.availability)}
                aria-describedby={errors.availability ? "area-availability-error" : undefined}
                data-setup-error={errors.availability && index === 0 ? "true" : undefined}
              >
                <option value="full">{t("prototype.af3463d5f866")}</option>
                <option value="limited">{t("prototype.cb0f02a4ec40")}</option>
                <option value="unavailable">{t("prototype.ca1844969742")}</option>
              </select>
            </label>
          ))}
        </div>
        {errors.availability && (
          <small id="area-availability-error" className={cx(componentStyles, `field-error ${styles.fieldError}`)}>
            <Warning />
            {errors.availability}
          </small>
        )}
      </section>
      <section className={cx(componentStyles, "capacity-detail-section")} aria-labelledby="unavailable-heading">
        <div className={cx(componentStyles, "section-heading")}>
          <div>
            <p className={cx(componentStyles, "eyebrow")}>{t("prototype.59be71333c96")}</p>
            <h3 id="unavailable-heading">{t("prototype.abb744994717")}</h3>
          </div>
        </div>
        {unavailableMinutes > 0 ? (
          <div className={cx(componentStyles, "unavailable-period")}>
            <Warning />
            <span>
              <strong>{t("prototype.9c0b0f1cc170")}</strong>
              <small>
                {t("prototype.a3139605b539")} {unavailableMinutes} {t("prototype.8157fd8329de")}
              </small>
            </span>
            <button type="button" className={primitiveStyles.textButton} onClick={() => setUnavailableMinutes(0)}>
              {t("prototype.c3812fc4acb8")}
            </button>
          </div>
        ) : (
          <button
            className={cx(componentStyles, "button secondary")}
            type="button"
            onClick={() => setUnavailableMinutes(60)}
          >
            <Plus />
            {t("prototype.d5c6caa8748e")}
          </button>
        )}
      </section>
    </div>
  );
}

function SettingsStep({
  mode,
  setMode,
}: {
  mode: "recommended" | "customised";
  setMode: (mode: "recommended" | "customised") => void;
}) {
  return (
    <div className={cx(componentStyles, "form-stack")}>
      <div className={cx(componentStyles, "mode-heading")}>
        <div>
          <p className={cx(componentStyles, "eyebrow")}>{t("prototype.848803e0d45b")}</p>
          <h3>{mode === "recommended" ? t("prototype.cfb32983e472") : t("prototype.6869a9bc5361")}</h3>
        </div>
        <button className={primitiveStyles.textButton} type="button" onClick={() => setMode("recommended")}>
          {t("prototype.6d662f23ade7")}
        </button>
      </div>
      <div className={cx(componentStyles, "choice-list")}>
        {[
          t("prototype.e0729027bb99"),
          t("prototype.6f7a50c08279"),
          t("prototype.72eebab3f1e9"),
          t("prototype.4c6b285588ba"),
        ].map((setting) => (
          <label key={setting}>
            <input type="checkbox" defaultChecked onChange={() => setMode("customised")} />
            <span>
              <strong>{setting}</strong>
              <small>{t("prototype.2d3afcd3a109")}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function EntriesStep() {
  const [method, setMethod] = useState<string>(opaqueId("manual"));
  return (
    <div className={cx(componentStyles, "form-stack")}>
      <div className={cx(componentStyles, "tab-list")} role="tablist" aria-label={t("prototype.8c4d33fceed9")}>
        {entryMethods.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => setMethod(id)}>
            {id === "manual" ? <Plus /> : id === "paste" ? <ClipboardText /> : <UploadSimple />}
            {label}
          </button>
        ))}
      </div>
      {method === "manual" ? (
        <div className={cx(componentStyles, "entry-table")}>
          <div>
            <strong>{t("prototype.5985039f106d")}</strong>
            <strong>{t("prototype.85a0c348e2a1")}</strong>
            <strong>{t("prototype.367ef06b8fbf")}</strong>
            <strong>{t("prototype.12f67f8539c4")}</strong>
          </div>
          {[
            [t("prototype.2b4e73ebbf39"), t("prototype.ed077f3d8125"), "1", t("prototype.34233e542b7b")],
            [t("prototype.6f4c82dde169"), t("prototype.ed077f3d8125"), "2", t("prototype.757ee88c6f78")],
          ].map((row) => (
            <div key={row[0]}>
              {row.map((cell) => (
                <span key={cell}>{cell}</span>
              ))}
            </div>
          ))}
          <button className={primitiveStyles.textButton} type="button">
            <Plus />
            {t("prototype.8101addc8e0e")}
          </button>
        </div>
      ) : method === "paste" ? (
        <Field label={t("prototype.0203777789f8")} hint={t("prototype.1833fb4261cc")}>
          <textarea placeholder={t("prototype.df9e8d882911")} />
        </Field>
      ) : (
        <div className={cx(componentStyles, "drop-zone")}>
          <UploadSimple />
          <strong>{t("prototype.a9688adc7e35")}</strong>
          <span>{t("prototype.3ee468dd80bb")}</span>
          <button className={cx(componentStyles, "button secondary")} type="button">
            {t("prototype.b09c73d9d3f8")}
          </button>
        </div>
      )}
      <div className={cx(componentStyles, "instruction")}>
        <UsersThree />
        <span>
          <strong>{t("prototype.60450f39c061")}</strong> {t("prototype.5a5279bd19e2")}
        </span>
      </div>
    </div>
  );
}

function PreferencesStep() {
  return (
    <div className={cx(componentStyles, "form-stack")}>
      <p className={cx(componentStyles, "section-intro")}>{t("prototype.2c03f4fc7377")}</p>
      <div className={cx(componentStyles, "choice-list")}>
        {[
          t("prototype.3b54c5bcc349"),
          t("prototype.d8667d7f48a2"),
          t("prototype.f3c88a85ec1f"),
          t("prototype.2e5e19f3174d"),
        ].map((item, index) => (
          <label key={item}>
            <input type="checkbox" defaultChecked={index < 3} />
            <span>
              <strong>{item}</strong>
              <small>
                {index === 0
                  ? t("prototype.5420b1a74638")
                  : index === 1
                    ? t("prototype.64ffb45e19e7")
                    : t("prototype.2dc1c226fdce")}
              </small>
            </span>
          </label>
        ))}
      </div>
      <Field label={t("prototype.2ebb76bb531c")}>
        <select defaultValue={opaqueId("fair")}>
          <option value="fair">{t("prototype.fa41374e5ca8")}</option>
          <option value="time">{t("prototype.0f959e2226d8")}</option>
          <option value="rest">{t("prototype.7909ddb885dd")}</option>
        </select>
      </Field>
    </div>
  );
}

function RecommendationsStep({
  selected,
  setSelected,
  estimates,
  teams,
  divisions,
  slotMinutes,
  reserve,
  capacityAcknowledged,
  setCapacityAcknowledged,
  error,
}: {
  selected: RecommendationId;
  setSelected: (value: RecommendationId) => void;
  estimates: Record<RecommendationId, number>;
  teams: number;
  divisions: number;
  slotMinutes: number;
  reserve: number;
  capacityAcknowledged: boolean;
  setCapacityAcknowledged: (value: boolean) => void;
  error?: string;
}) {
  const options: ReadonlyArray<{
    id: RecommendationId;
    name: string;
    minimum: string;
    stages: string;
    note: string;
  }> = [
    {
      id: opaqueId("fast"),
      name: t("prototype.f824d76d7765"),
      minimum: "3",
      stages: t("prototype.0cbb45b7e5e9"),
      note: t("prototype.27d05a69b8df"),
    },
    {
      id: opaqueId("balanced"),
      name: t("prototype.4a4e5aaf90eb"),
      minimum: "4",
      stages: t("prototype.270a09238606"),
      note: t("prototype.c5a7c7e7d89f"),
    },
    {
      id: opaqueId("depth"),
      name: t("prototype.befbb2fad648"),
      minimum: "4",
      stages: t("prototype.a6560d57ea11"),
      note: t("prototype.77b0f34b7331"),
    },
  ];
  return (
    <div className={cx(componentStyles, "form-stack")} data-setup-step="5">
      <p className={styles.estimateDisclosure}>
        <strong>{t("prototype.6483a855b640")}</strong>
        {t("prototype.5e7c14e47e81", { teams, divisionLabel: formatDivisionCount(divisions) })}{" "}
        {t("prototype.e14e8b99db9e")}
      </p>
      <div className={cx(componentStyles, "recommendation-grid")}>
        {options.map((option) => {
          const matches = estimates[option.id];
          const hours = (matches * slotMinutes) / 60;
          return (
            <button
              key={option.id}
              type="button"
              className={cx(componentStyles, selected === option.id && "is-selected")}
              aria-pressed={selected === option.id}
              onClick={() => setSelected(option.id)}
            >
              <span className={cx(componentStyles, "recommendation-check")}>
                {selected === option.id ? <Check /> : null}
              </span>
              <p className={cx(componentStyles, "eyebrow")}>
                {option.id === "balanced" ? t("prototype.d70604e84304") : t("prototype.45aaacba7ea1")}
              </p>
              <h3>{option.name}</h3>
              <strong>
                {t("prototype.de98e7fb1466", {
                  matches,
                  hours: Number.isInteger(hours) ? hours : hours.toFixed(1),
                })}
              </strong>
              <dl>
                <div>
                  <dt>{t("prototype.735beee2e390")}</dt>
                  <dd>
                    {option.minimum} {t("prototype.a962badf248a")}
                  </dd>
                </div>
                <div>
                  <dt>{t("prototype.74ab7c9dbf27")}</dt>
                  <dd>{option.stages}</dd>
                </div>
              </dl>
              <p>{option.note}</p>
            </button>
          );
        })}
      </div>
      {reserve < 0 && (
        <div className={styles.capacityGate}>
          <Warning aria-hidden="true" />
          <div>
            <strong>{t("prototype.c8bd34ee6e6d")}</strong>
            <label>
              <input
                type="checkbox"
                checked={capacityAcknowledged}
                onChange={(event) => setCapacityAcknowledged(event.target.checked)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "capacity-acknowledgement-error" : undefined}
                data-setup-error={error ? "true" : undefined}
              />
              <span>
                {t("prototype.35d5b0f19a66", {
                  matches: estimates[selected],
                  shortfall: Math.abs(reserve),
                })}
              </span>
            </label>
            {error && (
              <small
                id="capacity-acknowledgement-error"
                className={cx(componentStyles, `field-error ${styles.fieldError}`)}
              >
                <Warning />
                {error}
              </small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleStep({
  selected,
  setSelected,
  error,
}: {
  selected: "fastest" | "balanced" | "rest";
  setSelected: (value: "fastest" | "balanced" | "rest") => void;
  error?: string;
}) {
  const options: ReadonlyArray<readonly ["fastest" | "balanced" | "rest", string, string]> = [
    [opaqueId("fastest"), t("prototype.7ef7a92e55a7"), t("prototype.7c3ee305f12c")],
    [opaqueId("balanced"), t("prototype.5386ea5db81c"), t("prototype.d8781eb341cc")],
    [opaqueId("rest"), t("prototype.fb2467ea8ea5"), t("prototype.9756e2959748")],
  ];
  return (
    <div className={cx(componentStyles, "schedule-options")} data-setup-step="6">
      {options.map(([id, title, copy]) => (
        <button
          key={id}
          type="button"
          aria-pressed={selected === id}
          className={cx(componentStyles, selected === id && "is-selected")}
          onClick={() => setSelected(id)}
        >
          <Clock />
          <span>
            <strong>{title}</strong>
            <small>{copy}</small>
          </span>
          <span className={cx(componentStyles, "radio-mark")} />
        </button>
      ))}
      {error && (
        <small className={cx(componentStyles, `field-error ${styles.fieldError}`)}>
          <Warning />
          {error}
        </small>
      )}
    </div>
  );
}

function ReviewStep({
  offline,
  estimatedMatches,
  slots,
  reserve,
}: {
  offline: boolean;
  estimatedMatches: number;
  slots: number;
  reserve: number;
}) {
  return (
    <div className={cx(componentStyles, "review-list")} data-setup-step="7">
      <div className={cx(componentStyles, `review-status${reserve < 0 ? " is-warning" : ""}`)}>
        {reserve < 0 ? <Warning /> : <Check />}
        <span>
          <strong>{reserve < 0 ? t("prototype.c8bd34ee6e6d") : t("prototype.db7dde0ba528")}</strong>
          {reserve < 0
            ? t("prototype.5d74e6e1219c", { matches: estimatedMatches, shortfall: Math.abs(reserve) })
            : t("prototype.6b422f46a213", { matches: estimatedMatches, slots })}
        </span>
      </div>
      <div className={cx(componentStyles, "review-status")}>
        <Check />
        <span>
          <strong>{t("prototype.2c99f6d33e41")}</strong>
          {t("prototype.98995a5c51bd")}
        </span>
      </div>
      <div className={cx(componentStyles, "review-status is-warning")}>
        <Warning />
        <span>
          <strong>{t("prototype.cefb5f6e905b")}</strong>
          {t("prototype.5f8c1e4f6d5e")}
        </span>
      </div>
      {offline && (
        <div className={cx(componentStyles, "review-status is-warning")}>
          <CloudSlash />
          <span>
            <strong>{t("prototype.6e6119da3c13")}</strong>
            {t("prototype.8ff6ce3b7467")}
          </span>
        </div>
      )}
      <div className={cx(componentStyles, "publish-summary")}>
        <p className={cx(componentStyles, "eyebrow")}>{t("prototype.ba252867a8e3")}</p>
        <ul>
          <li>{t("prototype.a511c77eac80")}</li>
          <li>{t("prototype.0c851e29e32d")}</li>
          <li>{t("prototype.3aedc8ba9639")}</li>
        </ul>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  messageId,
  children,
  wide = false,
}: {
  label: string;
  hint?: string;
  error?: string;
  messageId?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={cx(componentStyles, `field${wide ? " is-wide" : ""}`)}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && (
        <small id={messageId} className={cx(componentStyles, `field-error ${styles.fieldError}`)}>
          <Warning />
          {error}
        </small>
      )}
    </label>
  );
}

function LoadingForm() {
  return (
    <div className={cx(componentStyles, "loading-form")} role="status" aria-label={t("prototype.b57f60662ba7")}>
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function minutesBetween(opening: string, closing: string) {
  const [openingHour, openingMinute] = opening.split(":").map(Number);
  const [closingHour, closingMinute] = closing.split(":").map(Number);
  return Math.max(0, closingHour * 60 + closingMinute - openingHour * 60 - openingMinute);
}

function formatHours(minutes: number) {
  const hours = minutes / 60;
  return t("prototype.d11dfabb5d3a", { hours: Number.isInteger(hours) ? hours : hours.toFixed(1) });
}

function formatDivisionCount(count: number) {
  return count === 1 ? t("prototype.f77e6cd9359a", { count }) : t("prototype.d2a2c4bcdf75", { count });
}
