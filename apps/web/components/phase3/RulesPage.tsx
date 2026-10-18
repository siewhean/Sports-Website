"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { InfoTip } from "@matchday/ui/react";
import { useRouter } from "next/navigation";
import { ArrowCounterClockwise, FloppyDisk, Warning } from "@phosphor-icons/react";
import type { SettingValue, SportPackSettings } from "@matchday/domain";
import {
  changedAnnouncement,
  deriveSportSettingsOverride,
  formatAffectedMatchesTitle,
  formatAffectedMatchItem,
  formatMoreMatches,
  phase3CommandMachine,
  phase3SettingsCopy,
  phase3SettingsMachine,
  sportSettingsScopeBaseline,
  validateSettingsDraft,
  type SportSettingsDocument,
  type SportSettingsSurfaceState,
} from "@/lib/phase3-sport-settings";
import {
  buildRulesGroups,
  resetRule,
  ruleDefaultLabel,
  rulesCopy,
  rulesHistoryLines,
  rulesTieBreakText,
  type RulesHistory,
} from "@/lib/phase3-rules";
import { SettingField, SettingsState } from "./SportSettingsEditor";
import { phase3Classes } from "./phase3Classes";
import editorStyles from "./SportSettingsEditor.module.css";
import styles from "./RulesPage.module.css";

const cx = (...values: Parameters<typeof phase3Classes>[1][]) =>
  phase3Classes({ ...editorStyles, ...styles }, ...values);

type Props = Readonly<{
  document: SportSettingsDocument;
  history: RulesHistory;
  competitionHref?: string;
  divisionHref?: string;
}>;

/**
 * Redesign Phase 4 Setup → Rules (flag `redesign_p4_rules`): the competition's rules in groups, each with its
 * default, a "Changed" mark and Reset, where it comes from, the tie-break rules in plain words and the list of
 * rules changes. Saving uses the existing sport-settings command, so every save is a new version.
 */
type ConfirmDialogState = {
  title: string;
  body: string;
  affectedMatches?: { id: string; division_id: string; status: string }[];
  onConfirm: () => Promise<void>;
};

export function RulesPage({ document, history, competitionHref, divisionHref }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<SportPackSettings>(document.effective);
  const [savedValues, setSavedValues] = useState<SportPackSettings>(document.effective);
  const [revision, setRevision] = useState(document.revision);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [commandError, setCommandError] = useState("");
  const [commandState, setCommandState] = useState<SportSettingsSurfaceState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (confirmDialog) {
      modalTriggerRef.current = window.document.activeElement as HTMLElement | null;
      const controls = modalRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      controls?.[0]?.focus();
    } else {
      modalTriggerRef.current?.focus();
      modalTriggerRef.current = null;
    }
  }, [confirmDialog]);

  function handleModalKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setConfirmDialog(null);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      modalRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && window.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && window.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  const pack = document.packDefinition;
  const snapshot = document.recommended;
  const scopeBaseline = sportSettingsScopeBaseline(document);
  const groups = useMemo(() => buildRulesGroups(pack, snapshot, values), [pack, snapshot, values]);
  const errors = useMemo(() => validateSettingsDraft(pack, values), [pack, values]);
  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const editable = document.canEdit && document.capabilities.save;
  const blocked = !editable || Object.keys(errors).length > 0 || busy;

  if (commandState && commandState !== phase3SettingsMachine.conflict)
    return <SettingsState state={commandState as Exclude<SportSettingsSurfaceState, "ready" | "loading">} />;
  if (document.state === "loading") return <SettingsState state={phase3SettingsMachine.unavailable} />;
  if (document.state !== "ready" && document.state !== "conflict" && document.state !== "read-only")
    return <SettingsState state={document.state} />;

  function update(setting: string, value: SettingValue) {
    setValues((current) => ({ ...current, [setting]: value }));
    setAnnouncement(changedAnnouncement(pack.settingsSchema[setting]?.label ?? setting));
  }

  function reset(setting: string) {
    setValues((current) => resetRule(current, snapshot, setting));
    setAnnouncement(changedAnnouncement(pack.settingsSchema[setting]?.label ?? setting));
  }

  async function save(confirmResultsAffected = false) {
    setBusy(true);
    setCommandError("");
    const competitionId = encodeURIComponent(document.context.competitionId);
    const divisionId = document.context.divisionId ? encodeURIComponent(document.context.divisionId) : null;
    const target = divisionId
      ? `/api/phase3/competitions/${competitionId}/divisions/${divisionId}/settings`
      : `/api/phase3/competitions/${competitionId}/settings`;
    try {
      const response = await fetch(target, {
        method: phase3CommandMachine.put,
        headers: { "content-type": phase3CommandMachine.applicationJson },
        body: JSON.stringify({
          pack_version: document.packVersion,
          revision,
          override: deriveSportSettingsOverride(values, scopeBaseline),
          ...(confirmResultsAffected ? { confirm_results_affected: true } : {}),
        }),
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as {
          error?: {
            code?: string;
            message?: string;
            details?: {
              affected_matches?: { id: string; division_id: string; status: string }[];
            };
          };
        } | null;
        const errorCode = errorPayload?.error?.code;
        if (response.status === 409) {
          if (errorCode === "RESULTS_EXIST_CONFIRMATION_REQUIRED") {
            setConfirmDialog({
              title: phase3SettingsCopy.resultsExistConfirmTitle,
              body: phase3SettingsCopy.resultsExistConfirmBody,
              affectedMatches: errorPayload?.error?.details?.affected_matches ?? [],
              onConfirm: async () => {
                setConfirmDialog(null);
                await save(true);
              },
            });
          } else {
            setCommandState(phase3SettingsMachine.conflict);
          }
        } else if (response.status === 401 || response.status === 403) {
          setCommandState(phase3SettingsMachine.permission);
        } else {
          setCommandError(phase3SettingsCopy.commandFailed);
        }
        return;
      }
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const nextRevision = payload?.revision;
      if (!Number.isInteger(nextRevision)) {
        setCommandError(phase3SettingsCopy.commandInvalid);
        return;
      }
      setSavedValues(values);
      setRevision(nextRevision as number);
      setAnnouncement(rulesCopy.saved);
      router.refresh();
    } catch {
      setCommandState(phase3SettingsMachine.offline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx("p3-settings")} data-state={document.state} data-testid="rules-page">
      <p className={cx("p3-live")} aria-live="polite">
        {announcement}
      </p>
      {document.state === phase3SettingsMachine.conflict || commandState === phase3SettingsMachine.conflict ? (
        <SettingsState
          state={phase3SettingsMachine.conflict}
          compact
          onConflictRetry={() => {
            setCommandState(null);
            router.refresh();
          }}
        />
      ) : null}

      <section className={cx("p3-settings-context")} aria-labelledby="rules-context-title">
        <div>
          <p className={cx("p3-kicker")}>{rulesCopy.eyebrow}</p>
          <h2 id="rules-context-title">{document.sportName}</h2>
          <p>{rulesCopy.intro}</p>
        </div>
        <nav aria-label={phase3SettingsCopy.settingsLevel}>
          <a aria-current={document.context.scope === "competition" ? "page" : undefined} href={competitionHref ?? "#"}>
            {phase3SettingsCopy.competition}
          </a>
          <a aria-current={document.context.scope === "division" ? "page" : undefined} href={divisionHref ?? "#"}>
            {document.context.divisionName ?? phase3SettingsCopy.division}
          </a>
        </nav>
        <dl>
          <div>
            <dt>{rulesCopy.packLabel}</dt>
            <dd>{document.packVersion}</dd>
          </div>
          <div>
            <dt>{rulesCopy.versionLabel}</dt>
            <dd>{revision}</dd>
          </div>
        </dl>
      </section>

      {!editable ? (
        <p className={cx("rules-readonly")} role="status">
          {rulesCopy.readOnly}
        </p>
      ) : null}

      <form
        className={cx("rules-form")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked && dirty) void save();
        }}
      >
        {groups.map((group) => (
          <section
            key={group.id}
            className={cx("rules-group")}
            aria-labelledby={`rules-group-${group.id}`}
            data-testid={`rules-group-${group.id}`}
          >
            <h3 id={`rules-group-${group.id}`}>{group.title}</h3>
            {group.rows.map((row) => (
              <div
                key={row.setting}
                className={cx("rules-row")}
                data-testid={`rule-${row.setting}`}
                data-changed={row.changed ? "true" : "false"}
              >
                <SettingField
                  id={`rule-field-${row.setting}`}
                  definition={pack.settingsSchema[row.setting]!}
                  value={values[row.setting]}
                  {...(errors[row.setting] ? { error: errors[row.setting] } : {})}
                  disabled={!editable || busy}
                  onChange={(value) => update(row.setting, value)}
                />
                <div className={cx("rules-meta")}>
                  <span>{ruleDefaultLabel(row)}</span>
                  {row.changed ? (
                    <span className={cx("rules-chip")} title={row.source ? rulesCopy.changedFromFederation : undefined}>
                      {rulesCopy.changed}
                    </span>
                  ) : null}
                  <InfoTip label={rulesCopy.aboutRule(row.label)}>{row.sourceText ?? rulesCopy.noSource}</InfoTip>
                  {row.changed && editable ? (
                    <button
                      className={cx("p3-text-action")}
                      type="button"
                      aria-label={rulesCopy.resetRule(row.label)}
                      disabled={busy}
                      onClick={() => reset(row.setting)}
                    >
                      <ArrowCounterClockwise aria-hidden="true" />
                      {rulesCopy.reset}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {group.id === "standings" ? (
              <div className={cx("rules-tiebreaks")} data-testid="rules-tiebreaks">
                <h4>{rulesCopy.tieBreaksTitle}</h4>
                <p>{rulesTieBreakText(pack, values)}</p>
              </div>
            ) : null}
          </section>
        ))}

        <footer className={cx("p3-settings-actions")}>
          <button
            className={cx("p3-button", "p3-button--primary")}
            data-testid="rules-save"
            type="submit"
            disabled={blocked || !dirty}
          >
            <FloppyDisk aria-hidden="true" />
            {busy ? rulesCopy.saving : rulesCopy.save}
          </button>
          <span>{dirty ? rulesCopy.unsaved : rulesCopy.noChanges}</span>
          {commandError ? (
            <strong className={cx("p3-command-error")} role="alert">
              <Warning aria-hidden="true" />
              {commandError}
            </strong>
          ) : null}
        </footer>
      </form>

      <section className={cx("rules-history")} aria-labelledby="rules-history-title" data-testid="rules-history">
        <h2 id="rules-history-title">{rulesCopy.historyTitle}</h2>
        {history.state === "unavailable" ? (
          <p>{rulesCopy.historyUnavailable}</p>
        ) : history.items.length === 0 ? (
          <p>{rulesCopy.historyEmpty}</p>
        ) : (
          <ol>
            {history.items.map((item) => {
              const lines = rulesHistoryLines(item, pack);
              return (
                <li key={item.id}>
                  <p className={cx("rules-history__meta")}>
                    <time dateTime={item.occurredAt}>{rulesCopy.historyWhen(item.occurredAt)}</time>
                    <span>{rulesCopy.historyBy(item.actorName)}</span>
                    {item.revision !== null ? <span>{rulesCopy.historyVersion(item.revision)}</span> : null}
                    {item.divisionId ? <span>{rulesCopy.divisionScope}</span> : null}
                  </p>
                  {item.action === "sport_settings.copied" ? <p>{rulesCopy.historyCopied}</p> : null}
                  {item.action === "sport_settings.pack_switched" ? <p>{rulesCopy.historyPackSwitched}</p> : null}
                  {item.action === "sport_settings.defaults_updated" ? <p>{rulesCopy.historyDefaultsUpdated}</p> : null}
                  {lines.length > 0 ? (
                    <ul>
                      {lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>{rulesCopy.historyNoDetail}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {confirmDialog ? (
        <div
          ref={modalRef}
          className={editorStyles["p3-modal-overlay"]}
          role="dialog"
          aria-modal="true"
          aria-labelledby="p3-confirm-title"
          onKeyDown={handleModalKeyDown}
        >
          <div className={editorStyles["p3-modal"]}>
            <h3 id="p3-confirm-title">{confirmDialog.title}</h3>
            <p>{confirmDialog.body}</p>
            {confirmDialog.affectedMatches && confirmDialog.affectedMatches.length > 0 ? (
              <div className={editorStyles["p3-modal-matches"]}>
                <p className={editorStyles["p3-modal-matches-header"]}>
                  {formatAffectedMatchesTitle(confirmDialog.affectedMatches.length)}
                </p>
                <ul>
                  {confirmDialog.affectedMatches.slice(0, 10).map((m) => (
                    <li key={m.id}>{formatAffectedMatchItem(m.id, m.status)}</li>
                  ))}
                  {confirmDialog.affectedMatches.length > 10 ? (
                    <li>{formatMoreMatches(confirmDialog.affectedMatches.length - 10)}</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            <div className={editorStyles["p3-modal-actions"]}>
              <button
                className={cx("p3-button", "p3-button--secondary")}
                type="button"
                onClick={() => setConfirmDialog(null)}
              >
                {phase3SettingsCopy.confirmCancel}
              </button>
              <button
                className={cx("p3-button", "p3-button--primary")}
                type="button"
                onClick={() => void confirmDialog.onConfirm()}
              >
                {phase3SettingsCopy.confirmProceed}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
