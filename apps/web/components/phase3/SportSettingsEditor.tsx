"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  CheckCircle,
  Copy,
  FloppyDisk,
  Info,
  LockKey,
  Warning,
} from "@phosphor-icons/react";
import type { SettingDefinition, SettingValue, SportPackSettings } from "@matchday/domain";
import {
  displaySettingValue,
  deriveSportSettingsOverride,
  humaniseSettingOption,
  integerRangeHelp,
  changedAnnouncement,
  divisionSettingsTitle,
  moveSettingLabel,
  phase3SettingsCopy,
  phase3SettingsMachine,
  phase3CommandMachine,
  settingsMode,
  sportSettingsScopeBaseline,
  validateSettingsDraft,
  type SportSettingsDocument,
  type SportSettingsSurfaceState,
} from "@/lib/phase3-sport-settings";
import { phase3Classes } from "./phase3Classes";
import styles from "./SportSettingsEditor.module.css";

const cx = (...values: Parameters<typeof phase3Classes>[1][]) => phase3Classes(styles, ...values);

type Props = Readonly<{
  document: SportSettingsDocument;
  divisionHref?: string;
  competitionHref?: string;
}>;

const stateCopy: Record<Exclude<SportSettingsSurfaceState, "ready">, { title: string; body: string }> = {
  loading: { title: phase3SettingsCopy.loadingSettings, body: phase3SettingsCopy.loadingSettingsBody },
  empty: { title: phase3SettingsCopy.emptyTitle, body: phase3SettingsCopy.emptyBody },
  error: { title: phase3SettingsCopy.errorTitle, body: phase3SettingsCopy.errorBody },
  offline: { title: phase3SettingsCopy.offlineTitle, body: phase3SettingsCopy.offlineBody },
  conflict: {
    title: phase3SettingsCopy.conflictTitle,
    body: phase3SettingsCopy.conflictBody,
  },
  "read-only": { title: phase3SettingsCopy.readOnlyTitle, body: phase3SettingsCopy.readOnlyBody },
  permission: { title: phase3SettingsCopy.permissionTitle, body: phase3SettingsCopy.permissionBody },
  unavailable: { title: phase3SettingsCopy.unavailableTitle, body: phase3SettingsCopy.unavailableBody },
};

export function SportSettingsEditor({ document, divisionHref, competitionHref }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<SportPackSettings>(document.effective);
  const [savedValues, setSavedValues] = useState<SportPackSettings>(document.effective);
  const [announcement, setAnnouncement] = useState("");
  const [commandError, setCommandError] = useState("");
  const [commandState, setCommandState] = useState<SportSettingsSurfaceState | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "default" | "copy" | null>(null);
  const [revision, setRevision] = useState(document.revision);
  const scopeBaseline = sportSettingsScopeBaseline(document);
  const errors = useMemo(
    () => validateSettingsDraft(document.packDefinition, values),
    [document.packDefinition, values],
  );
  const mode = settingsMode(values, scopeBaseline);
  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const blocked =
    !document.canEdit || !document.capabilities.save || Object.keys(errors).length > 0 || busyAction !== null;

  if (document.state === "loading") return <SettingsSkeleton />;
  if (commandState && commandState !== "ready")
    return <SettingsState state={commandState as Exclude<SportSettingsSurfaceState, "ready" | "loading">} />;
  if (document.state !== "ready" && document.state !== "conflict" && document.state !== "read-only") {
    return <SettingsState state={document.state} />;
  }

  function update(key: string, value: SettingValue) {
    setValues((current) => ({ ...current, [key]: value }));
    setAnnouncement(changedAnnouncement(document.definitions[key]?.label ?? key));
  }

  function reset() {
    setValues(scopeBaseline);
    setAnnouncement(phase3SettingsCopy.restoredAnnouncement);
  }

  async function command(action: "save" | "default" | "copy") {
    setBusyAction(action);
    setCommandError("");
    const competitionId = encodeURIComponent(document.context.competitionId);
    const divisionId = document.context.divisionId ? encodeURIComponent(document.context.divisionId) : null;
    const target =
      action === "default"
        ? `/api/phase3/account/sport-defaults/${encodeURIComponent(document.sportId)}`
        : action === "copy"
          ? `/api/phase3/competitions/${competitionId}/settings/copy-previous`
          : divisionId
            ? `/api/phase3/competitions/${competitionId}/divisions/${divisionId}/settings`
            : `/api/phase3/competitions/${competitionId}/settings`;
    const body =
      action === "save"
        ? {
            pack_version: document.packVersion,
            revision,
            override: deriveSportSettingsOverride(values, scopeBaseline),
          }
        : action === "default"
          ? { pack_version: document.packVersion, settings: values }
          : undefined;
    try {
      const response = await fetch(target, {
        method: action === "copy" ? phase3CommandMachine.post : phase3CommandMachine.put,
        headers: body ? { "content-type": phase3CommandMachine.applicationJson } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        if (response.status === 409) setCommandState(phase3SettingsMachine.conflict);
        else if (response.status === 401 || response.status === 403) setCommandState(phase3SettingsMachine.permission);
        else setCommandError(phase3SettingsCopy.commandFailed);
        return;
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") {
        setCommandError(phase3SettingsCopy.commandInvalid);
        return;
      }
      if (action === "save") {
        const revision = (payload as Record<string, unknown>).revision;
        if (!Number.isInteger(revision)) {
          setCommandError(phase3SettingsCopy.commandInvalid);
          return;
        }
        setSavedValues(values);
        setRevision(revision as number);
        setAnnouncement(phase3SettingsCopy.savedAnnouncement);
      } else if (action === "default") {
        setAnnouncement(phase3SettingsCopy.defaultAnnouncement);
      } else {
        const revision = (payload as Record<string, unknown>).revision;
        if (!Number.isInteger(revision)) {
          setCommandError(phase3SettingsCopy.commandInvalid);
          return;
        }
        setAnnouncement(phase3SettingsCopy.copiedAnnouncement);
        router.refresh();
      }
    } catch {
      setCommandState(phase3SettingsMachine.offline);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className={cx("p3-settings")} data-state={document.state} data-testid="phase3-settings">
      <p className={cx("p3-live")} aria-live="polite">
        {announcement}
      </p>
      {document.state === phase3SettingsMachine.conflict ? (
        <SettingsState state={phase3SettingsMachine.conflict} compact />
      ) : null}
      {document.state === phase3SettingsMachine.readOnly ? (
        <SettingsState state={phase3SettingsMachine.readOnly} compact />
      ) : null}

      <section className={cx("p3-settings-context")} aria-labelledby="p3-settings-context-title">
        <div>
          <p className={cx("p3-kicker")}>{phase3SettingsCopy.eyebrow}</p>
          <h2 id="p3-settings-context-title">{document.sportName}</h2>
          <p>{document.context.competitionName}</p>
        </div>
        <nav aria-label={phase3SettingsCopy.settingsLevel}>
          <a aria-current={document.context.scope === "competition" ? "page" : undefined} href={competitionHref ?? "#"}>
            {phase3SettingsCopy.competition}
          </a>
          <a
            aria-current={document.context.scope === "division" ? "page" : undefined}
            href={divisionHref ?? "#division-settings"}
          >
            {document.context.divisionName ?? phase3SettingsCopy.division}
          </a>
        </nav>
        <dl>
          <div>
            <dt>{phase3SettingsCopy.packVersion}</dt>
            <dd>{document.packVersion}</dd>
          </div>
          <div>
            <dt>{phase3SettingsCopy.savedRevision}</dt>
            <dd>{revision}</dd>
          </div>
        </dl>
      </section>

      <div className={cx("p3-settings-layout")}>
        <form
          className={cx("p3-settings-form")}
          data-testid="phase3-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && dirty) void command(phase3SettingsMachine.save);
          }}
        >
          <header className={cx("p3-settings-form__head")}>
            <div>
              <span className={cx("p3-mode", `p3-mode--${mode}`)}>
                <CheckCircle weight="fill" aria-hidden="true" />
                {mode === "recommended" ? phase3SettingsCopy.recommended : phase3SettingsCopy.customised}
              </span>
              <h2>
                {document.context.scope === "division"
                  ? divisionSettingsTitle(document.context.divisionName)
                  : phase3SettingsCopy.competitionSettings}
              </h2>
              <p>
                {document.context.scope === "division"
                  ? phase3SettingsCopy.divisionScopeBody
                  : phase3SettingsCopy.competitionScopeBody}
              </p>
            </div>
            <button
              className={cx("p3-text-action")}
              type="button"
              onClick={reset}
              disabled={!document.canEdit || busyAction !== null}
            >
              <ArrowCounterClockwise aria-hidden="true" />
              {phase3SettingsCopy.reset}
            </button>
          </header>

          <div className={cx("p3-field-list")}>
            {Object.entries(document.definitions).map(([key, definition]) => (
              <SettingField
                key={key}
                id={key}
                definition={definition}
                value={values[key]}
                error={errors[key]}
                disabled={!document.canEdit || busyAction !== null}
                onChange={(value) => update(key, value)}
              />
            ))}
          </div>

          <footer className={cx("p3-settings-actions")}>
            <button
              className={cx("p3-button", "p3-button--primary")}
              data-testid="phase3-primary-action"
              type="submit"
              disabled={blocked || !dirty}
            >
              <FloppyDisk aria-hidden="true" />
              {busyAction === phase3SettingsMachine.save
                ? phase3SettingsCopy.saving
                : document.capabilities.save
                  ? phase3SettingsCopy.save
                  : phase3SettingsCopy.saveUnavailable}
            </button>
            <span>
              {dirty
                ? phase3SettingsCopy.localDraft
                : document.capabilities.save
                  ? phase3SettingsCopy.saved
                  : phase3SettingsCopy.commandsUnavailable}
            </span>
            {commandError ? (
              <strong className={cx("p3-command-error")} role="alert" aria-live="assertive">
                {commandError}
              </strong>
            ) : null}
          </footer>
        </form>

        <aside className={cx("p3-decision-rail")} aria-label={phase3SettingsCopy.settingsTools}>
          <section>
            <Info aria-hidden="true" />
            <p className={cx("p3-kicker")}>{phase3SettingsCopy.recommendation}</p>
            <h2>{phase3SettingsCopy.recommendationTitle}</h2>
            <p>{phase3SettingsCopy.recommendationBody}</p>
            <dl>
              {Object.entries(document.recommended)
                .slice(0, 4)
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{document.definitions[key]?.label ?? key}</dt>
                    <dd>{displaySettingValue(value)}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section>
            <p className={cx("p3-kicker")}>{phase3SettingsCopy.reuse}</p>
            <h2>{phase3SettingsCopy.reuseTitle}</h2>
            <label htmlFor="previous-competition">{phase3SettingsCopy.previousCompetition}</label>
            <select id="previous-competition" value="" disabled>
              <option value="">
                {document.capabilities.copyPrevious
                  ? phase3SettingsCopy.mostRecentCompatible
                  : phase3SettingsCopy.previousUnavailable}
              </option>
            </select>
            <button
              className={cx("p3-button", "p3-button--secondary")}
              type="button"
              disabled={!document.capabilities.copyPrevious || busyAction !== null}
              onClick={() => void command(phase3SettingsMachine.copy)}
            >
              <Copy aria-hidden="true" />
              {busyAction === phase3SettingsMachine.copy ? phase3SettingsCopy.copying : phase3SettingsCopy.copyPrevious}
            </button>
          </section>

          <section>
            <p className={cx("p3-kicker")}>{phase3SettingsCopy.personal}</p>
            <h2>{phase3SettingsCopy.personalTitle}</h2>
            <p>{phase3SettingsCopy.personalBody}</p>
            <button
              className={cx("p3-button", "p3-button--secondary")}
              type="button"
              disabled={!document.capabilities.saveDefault || busyAction !== null}
              onClick={() => void command(phase3SettingsMachine.default)}
            >
              <FloppyDisk aria-hidden="true" />
              {busyAction === phase3SettingsMachine.default
                ? phase3SettingsCopy.saving
                : phase3SettingsCopy.saveDefault}
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SettingField({
  id,
  definition,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  definition: SettingDefinition;
  value: SettingValue | undefined;
  error?: string;
  disabled: boolean;
  onChange(value: SettingValue): void;
}) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  if (definition.type === "boolean") {
    return (
      <div className={cx("p3-field", "p3-field--toggle")}>
        <div>
          <span className={cx("p3-field-label")} id={`${id}-label`}>
            {definition.label}
          </span>
          <small id={helpId}>{phase3SettingsCopy.booleanHelp}</small>
        </div>
        <label className={cx("p3-toggle-target")} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={helpId}
            onChange={(event) => onChange(event.target.checked)}
          />
        </label>
      </div>
    );
  }
  if (definition.type === "ordered_enum") {
    const orderedValues = Array.isArray(value) ? [...value] : [...definition.values];
    return (
      <fieldset className={cx("p3-field", "p3-field--ordered")} disabled={disabled} aria-describedby={helpId}>
        <legend>{definition.label}</legend>
        <small id={helpId}>{phase3SettingsCopy.orderedHelp}</small>
        <ol>
          {orderedValues.map((option, index) => (
            <li key={option}>
              <span>
                <b>{index + 1}</b>
                {humaniseSettingOption(option)}
              </span>
              <span>
                <button
                  type="button"
                  aria-label={moveSettingLabel(option, phase3SettingsMachine.up)}
                  disabled={index === 0}
                  onClick={() => onChange(moveItem(orderedValues, index, index - 1))}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={moveSettingLabel(option, phase3SettingsMachine.down)}
                  disabled={index === orderedValues.length - 1}
                  onClick={() => onChange(moveItem(orderedValues, index, index + 1))}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      </fieldset>
    );
  }
  const describedBy = error ? `${helpId} ${errorId}` : helpId;
  return (
    <div className={cx("p3-field")}>
      <label htmlFor={id}>{definition.label}</label>
      {definition.type === "integer" ? (
        <input
          id={id}
          type="number"
          min={definition.minimum}
          max={definition.maximum}
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.value === "" && definition.nullable ? null : Number(event.target.value))
          }
        />
      ) : (
        <select
          id={id}
          value={String(value ?? definition.values[0])}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          {definition.values.map((option) => (
            <option key={option} value={option}>
              {humaniseSettingOption(option)}
            </option>
          ))}
        </select>
      )}
      <small id={helpId}>
        {definition.type === "integer"
          ? integerRangeHelp(definition.minimum, definition.maximum)
          : phase3SettingsCopy.enumHelp}
      </small>
      {error ? (
        <span className={cx("p3-field__error")} id={errorId} role="alert" aria-live="polite">
          <Warning aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

function moveItem(values: readonly string[], from: number, to: number): readonly string[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function SettingsState({
  state,
  compact = false,
}: {
  state: Exclude<SportSettingsSurfaceState, "ready" | "loading">;
  compact?: boolean;
}) {
  const copy = stateCopy[state];
  const Icon = state === "permission" || state === "read-only" ? LockKey : Warning;
  return (
    <section
      className={cx("p3-state", compact && "p3-state--compact")}
      role={state === "conflict" || state === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" />
      <div>
        <p className={cx("p3-kicker")}>{state.replace("-", " ")}</p>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        {state === "conflict" ? (
          <button
            className={cx("p3-button", "p3-button--secondary")}
            type="button"
            onClick={() => window.location.reload()}
          >
            {phase3SettingsCopy.reload}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SettingsSkeleton() {
  return (
    <section className={cx("p3-skeleton")} aria-busy="true" aria-label={phase3SettingsCopy.loadingAria}>
      <div className={cx("p3-skeleton-context")}>
        <span />
        <span />
        <span />
      </div>
      <div className={cx("p3-skeleton-layout")}>
        <div className={cx("p3-skeleton-fields")}>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <div className={cx("p3-skeleton-rail")}>
          <span />
          <span />
          <span />
        </div>
      </div>
    </section>
  );
}
