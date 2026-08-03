"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { GateCRepairActionView, GateCRepairWorkspaceView } from "@matchday/contracts";
import {
  gateCC4Copy,
  gateCC4Machine,
  parseGateCC4RepairQueue,
  parseGateCC4Workspace,
  repairRevisionRequest,
  type GateCC4DecisionDraft,
  type GateCC4RepairQueueItem,
} from "@/lib/gate-c-c4";
import { gateCC4Http, gateCC4UiMachine } from "@/lib/gate-c-c4-http";
import {
  gateCC4DecisionOptions,
  gateCC4DecisionRequired,
  gateCC4DecisionValues,
  gateCC4MatchScheduleAdjustmentAllowed,
  type GateCC4DecisionValue,
} from "@/lib/gate-c-c4-decisions";
import { parseGateCC4References, type GateCC4ReferenceData } from "@/lib/gate-c-c4-references";
import { isGateCC4PublicationReceipt, isGateCC4RevisionResponse } from "@/lib/gate-c-c4-validators";
import styles from "./RepairWorkspace.module.css";

type DecisionValue = "" | GateCC4DecisionValue;

type ActionDraft = {
  clientEventId: string;
  decision: DecisionValue;
  selectedEntryId: string;
  reason: string;
  startsAt: string;
  endsAt: string;
  playingAreaId: string;
};

type MatchOption = Readonly<{ id: string; label: string; home: string; away: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function upstreamMessage(payload: unknown): string {
  return record(payload) && record(payload.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : gateCC4Copy.failed;
}

function title(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function actionAllowsDecision(action: GateCRepairActionView): boolean {
  return action.source_action !== gateCC4UiMachine.noChangeAction;
}

function decisionLabel(decision: GateCC4DecisionValue): string {
  switch (decision) {
    case gateCC4DecisionValues.acceptProposed:
      return gateCC4Copy.acceptProposed;
    case gateCC4DecisionValues.keepCurrent:
      return gateCC4Copy.keepCurrent;
    case gateCC4DecisionValues.setManualEntry:
      return gateCC4Copy.setManual;
    case gateCC4DecisionValues.leaveProtected:
      return gateCC4Copy.leaveProtected;
  }
}

function defaultDraft(action: GateCRepairActionView): ActionDraft {
  return {
    clientEventId: crypto.randomUUID(),
    decision: action.decision ?? "",
    selectedEntryId: action.resolved_entry_id ?? "",
    reason: action.decision ? action.reason : "",
    startsAt: localDateTime(action.adjustment?.starts_at),
    endsAt: localDateTime(action.adjustment?.ends_at),
    playingAreaId: action.adjustment?.playing_area_id ?? "",
  };
}

async function downloadVerifiedPdf(response: Response): Promise<void> {
  if (!response.ok) throw new Error(upstreamMessage(await response.json().catch(() => null)));
  const expectedHash = response.headers.get(gateCC4Http.contentSha256Header);
  const disposition = response.headers.get(gateCC4Http.contentDispositionHeader) ?? "";
  const filename = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf)"$/u.exec(disposition)?.[1];
  if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash) || !filename) {
    throw new Error(gateCC4Copy.failed);
  }
  const blob = await response.blob();
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const actualHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== expectedHash) throw new Error(gateCC4Copy.failed);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement(gateCC4Http.anchorTag);
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function RepairWorkspace({
  competitionId,
  matches,
}: {
  competitionId: string;
  matches: readonly MatchOption[];
}) {
  const [queue, setQueue] = useState<GateCC4RepairQueueItem[]>([]);
  const [workspace, setWorkspace] = useState<GateCRepairWorkspaceView | null>(null);
  const [references, setReferences] = useState<GateCC4ReferenceData>({ entries: [], playing_areas: [] });
  const [drafts, setDrafts] = useState<Record<string, ActionDraft>>({});
  const [correctionId, setCorrectionId] = useState("");
  const [abandonReason, setAbandonReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const repairToFocusRef = useRef<string | null>(null);

  const loadWorkspace = useCallback(
    async (repairId: string) => {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(repairId)}`,
        { cache: gateCC4Http.cacheNoStore },
      );
      const payload: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? parseGateCC4Workspace(payload) : null;
      if (!parsed) throw new Error(upstreamMessage(payload));
      setWorkspace(parsed);
      setDrafts(Object.fromEntries(parsed.actions.map((action) => [action.repair_action_id, defaultDraft(action)])));
    },
    [competitionId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [queueResponse, referencesResponse] = await Promise.all([
        fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs`, {
          cache: gateCC4Http.cacheNoStore,
        }),
        fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/references`, {
          cache: gateCC4Http.cacheNoStore,
        }),
      ]);
      const [queuePayload, referencesPayload]: [unknown, unknown] = await Promise.all([
        queueResponse.json().catch(() => null),
        referencesResponse.json().catch(() => null),
      ]);
      const parsedQueue = queueResponse.ok ? parseGateCC4RepairQueue(queuePayload) : null;
      const parsedReferences = referencesResponse.ok ? parseGateCC4References(referencesPayload) : null;
      if (!parsedQueue || !parsedReferences) throw new Error(upstreamMessage(queuePayload));
      setQueue(parsedQueue);
      setReferences(parsedReferences);
      const preferred = parsedQueue.find((item) => item.latest_status === "draft" || item.latest_status === "ready");
      if (preferred) await loadWorkspace(preferred.repair_id);
      else setWorkspace(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setLoading(false);
    }
  }, [competitionId, loadWorkspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const handleRepairCreated = (event: Event) => {
      if (!(event instanceof CustomEvent) || !record(event.detail) || typeof event.detail.repairId !== "string") return;
      repairToFocusRef.current = event.detail.repairId;
      void loadWorkspace(event.detail.repairId).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
      });
    };
    window.addEventListener(gateCC4UiMachine.repairCreatedEvent, handleRepairCreated);
    return () => window.removeEventListener(gateCC4UiMachine.repairCreatedEvent, handleRepairCreated);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!workspace || repairToFocusRef.current !== workspace.repair.repair_id) return;
    repairToFocusRef.current = null;
    const timer = window.setTimeout(() => {
      workspaceHeadingRef.current?.focus();
      setMessage(gateCC4Copy.workspaceOpened);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  const unresolved = useMemo(
    () =>
      workspace?.actions.filter((action) => {
        if (!gateCC4DecisionRequired(action.source_action)) return false;
        const draft = drafts[action.repair_action_id];
        return (
          !draft?.decision ||
          draft.reason.trim().length < 3 ||
          (draft.decision === "set_manual_entry" && !draft.selectedEntryId)
        );
      }) ?? [],
    [drafts, workspace],
  );

  function updateDraft(actionId: string, patch: Partial<ActionDraft>) {
    setDrafts((current) => ({
      ...current,
      [actionId]: {
        ...(current[actionId] ?? {
          clientEventId: crypto.randomUUID(),
          decision: "",
          selectedEntryId: "",
          reason: "",
          startsAt: "",
          endsAt: "",
          playingAreaId: "",
        }),
        ...patch,
      },
    }));
    setMessage("");
    setError("");
  }

  async function analyse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !correctionId) return;
    setBusy(gateCC4UiMachine.analyseBusy);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs`, {
        method: gateCC4Machine.post,
        headers: { "content-type": gateCC4Http.jsonContentType },
        body: JSON.stringify({ correction_transaction_id: correctionId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? parseGateCC4Workspace(payload) : null;
      if (!parsed) throw new Error(upstreamMessage(payload));
      setWorkspace(parsed);
      setDrafts(Object.fromEntries(parsed.actions.map((action) => [action.repair_action_id, defaultDraft(action)])));
      setCorrectionId("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setBusy(null);
    }
  }

  async function saveRevision(status: "draft" | "ready") {
    if (!workspace?.latest_revision || busy || (status === "ready" && unresolved.length > 0)) return;
    setBusy(status);
    setError("");
    setMessage("");
    try {
      const decisions: GateCC4DecisionDraft[] = workspace.actions.flatMap((action) => {
        const draft = drafts[action.repair_action_id];
        if (!draft?.decision) return [];
        return [
          {
            client_event_id: draft.clientEventId,
            match_id: action.match_id,
            slot: action.slot,
            decision: draft.decision,
            ...(draft.decision === "set_manual_entry" ? { selected_entry_id: draft.selectedEntryId } : {}),
            reason: draft.reason.trim(),
            ...(draft.startsAt ? { starts_at: draft.startsAt } : {}),
            ...(draft.endsAt ? { ends_at: draft.endsAt } : {}),
            ...(draft.playingAreaId ? { playing_area_id: draft.playingAreaId } : {}),
          },
        ];
      });
      const request = repairRevisionRequest({ workspace, status, decisions });
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(workspace.repair.repair_id)}/revisions`,
        {
          method: gateCC4Machine.post,
          headers: { "content-type": gateCC4Http.jsonContentType },
          body: JSON.stringify(request),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isGateCC4RevisionResponse(payload)) throw new Error(upstreamMessage(payload));
      await loadWorkspace(workspace.repair.repair_id);
      setMessage(gateCC4Copy.saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!workspace?.latest_revision || !workspace.publication_ready || busy) return;
    setBusy(gateCC4UiMachine.publishBusy);
    setError("");
    setMessage("");
    try {
      const revision = workspace.latest_revision;
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(workspace.repair.repair_id)}/revisions/${encodeURIComponent(revision.repair_revision_id)}/publish`,
        {
          method: gateCC4Machine.post,
          headers: { "content-type": gateCC4Http.jsonContentType },
          body: JSON.stringify({
            competition_id: competitionId,
            repair_id: workspace.repair.repair_id,
            repair_revision_id: revision.repair_revision_id,
            expected_schedule_version: workspace.published_schedule_version,
            expected_result_version: workspace.current_result_version,
            expected_analysis_fingerprint: revision.analysis_fingerprint,
            publication_idempotency_key: `repair-publish:${revision.repair_revision_id}:${crypto.randomUUID()}`,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isGateCC4PublicationReceipt(payload)) throw new Error(upstreamMessage(payload));
      await refresh();
      setMessage(gateCC4Copy.publishedMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setBusy(null);
    }
  }

  async function abandon() {
    if (!workspace?.latest_revision || abandonReason.trim().length < 3 || busy) return;
    setBusy(gateCC4UiMachine.abandonBusy);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(workspace.repair.repair_id)}/abandon`,
        {
          method: gateCC4Machine.post,
          headers: { "content-type": gateCC4Http.jsonContentType },
          body: JSON.stringify({ expected_revision: workspace.latest_revision.revision, reason: abandonReason.trim() }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !record(payload) || payload.status !== gateCC4Machine.abandoned) {
        throw new Error(upstreamMessage(payload));
      }
      setAbandonReason("");
      await refresh();
      setMessage(gateCC4Copy.abandonedMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf(path: string, busyKey: string) {
    if (busy) return;
    setBusy(busyKey);
    setError("");
    try {
      await downloadVerifiedPdf(await fetch(path, { method: gateCC4Machine.post }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4Copy.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.workspace} data-testid="gate-c-c4-repair-workspace">
      <p className={styles.live} aria-live="polite" aria-atomic="true">
        {message}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <section className={styles.toolbar} aria-labelledby="repair-analysis-title">
        <div>
          <h2 id="repair-analysis-title">{gateCC4Copy.analyseTitle}</h2>
          <p>{gateCC4Copy.analyseBody}</p>
        </div>
        <form onSubmit={(event) => void analyse(event)}>
          <label htmlFor="c4-correction-id">{gateCC4Copy.correctionId}</label>
          <input
            id="c4-correction-id"
            value={correctionId}
            required
            pattern="[0-9a-fA-F-]{36}"
            onChange={(event) => setCorrectionId(event.currentTarget.value)}
          />
          <button type="submit" disabled={Boolean(busy) || !correctionId}>
            {busy === gateCC4UiMachine.analyseBusy ? gateCC4Copy.analysing : gateCC4Copy.analyse}
          </button>
        </form>
        <button type="button" disabled={loading || Boolean(busy)} onClick={() => void refresh()}>
          {loading ? gateCC4Copy.loading : gateCC4Copy.refresh}
        </button>
      </section>

      <div className={styles.layout}>
        <aside className={styles.queue} aria-label={gateCC4Copy.affected}>
          {queue.length ? (
            <ol>
              {queue.map((item) => (
                <li key={item.repair_id}>
                  <button
                    type="button"
                    aria-pressed={workspace?.repair.repair_id === item.repair_id}
                    onClick={() => void loadWorkspace(item.repair_id)}
                  >
                    <strong>{item.corrected_match_code}</strong>
                    <span>{item.division_name}</span>
                    <small>
                      {item.affected_action_count} {gateCC4Copy.affected} · {item.unresolved_action_count}{" "}
                      {gateCC4Copy.unresolved}
                    </small>
                    <em>{item.latest_status ? title(item.latest_status) : gateCC4Copy.required}</em>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className={styles.empty}>
              <h2>{gateCC4Copy.noRepairs}</h2>
              <p>{gateCC4Copy.noRepairsBody}</p>
            </div>
          )}
        </aside>

        <main className={styles.details}>
          {workspace ? (
            <>
              <header className={styles.summary}>
                <div>
                  <p>{gateCC4Copy.sourceVersions}</p>
                  <h2 ref={workspaceHeadingRef} tabIndex={-1}>
                    {workspace.repair.corrected_match_id}
                  </h2>
                </div>
                <dl>
                  <div>
                    <dt>{gateCC4Copy.resultVersion}</dt>
                    <dd>{workspace.current_result_version}</dd>
                  </div>
                  <div>
                    <dt>{gateCC4Copy.scheduleVersion}</dt>
                    <dd>{workspace.published_schedule_version}</dd>
                  </div>
                  <div>
                    <dt>{gateCC4Copy.unresolved}</dt>
                    <dd>{unresolved.length}</dd>
                  </div>
                </dl>
                <strong data-ready={workspace.publication_ready}>
                  {workspace.publication_ready ? gateCC4Copy.publicationReady : gateCC4Copy.publicationNotReady}
                </strong>
              </header>

              <div className={styles.actions}>
                {workspace.actions.map((action, index) => {
                  const draft = drafts[action.repair_action_id] ?? defaultDraft(action);
                  const decisionRequired = gateCC4DecisionRequired(action.source_action);
                  const decisionOptions = gateCC4DecisionOptions(
                    action.source_action,
                    action.proposed_entry_id !== null,
                  );
                  const allowsDecision = actionAllowsDecision(action);
                  const firstForMatch =
                    workspace.actions.findIndex((candidate) => candidate.match_id === action.match_id) === index;
                  const entries = references.entries.filter((entry) => entry.division_id === action.division_id);
                  const scheduleAdjustmentAllowed = gateCC4MatchScheduleAdjustmentAllowed(
                    workspace.actions
                      .filter((candidate) => candidate.match_id === action.match_id)
                      .map((candidate) => candidate.source_action),
                  );
                  return (
                    <section key={action.repair_action_id} className={styles.action} data-protected={decisionRequired}>
                      <header>
                        <div>
                          <p>{title(action.source_action)}</p>
                          <h3>
                            {action.match_id} · {title(action.slot)}
                          </h3>
                        </div>
                        <span>{decisionRequired ? gateCC4Copy.protected : gateCC4Copy.automatic}</span>
                      </header>
                      <dl>
                        <div>
                          <dt>{gateCC4Copy.currentEntry}</dt>
                          <dd>{action.current_entry_name ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>{gateCC4Copy.proposedEntry}</dt>
                          <dd>{action.proposed_entry_name ?? "—"}</dd>
                        </div>
                      </dl>
                      <p className={styles.reason}>{action.reason}</p>
                      <details>
                        <summary>{gateCC4Copy.dependency}</summary>
                        <ol>
                          {action.dependency_path.map((step, stepIndex) => (
                            <li key={`${step.source_match_id}-${step.downstream_match_id}-${stepIndex}`}>
                              {step.source_match_id} → {step.downstream_match_id} · {title(step.outcome)} ·{" "}
                              {title(step.slot)}
                            </li>
                          ))}
                        </ol>
                      </details>

                      {allowsDecision ? (
                        <div className={styles.decisionGrid}>
                          <label>
                            <span>{gateCC4Copy.decision}</span>
                            <select
                              value={draft.decision}
                              required={decisionRequired}
                              onChange={(event) =>
                                updateDraft(action.repair_action_id, {
                                  decision: event.currentTarget.value as DecisionValue,
                                })
                              }
                            >
                              <option value="">—</option>
                              {decisionOptions.map((decision) => (
                                <option key={decision} value={decision}>
                                  {decisionLabel(decision)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {draft.decision === "set_manual_entry" ? (
                            <label>
                              <span>{gateCC4Copy.selectedEntry}</span>
                              <select
                                value={draft.selectedEntryId}
                                required
                                onChange={(event) =>
                                  updateDraft(action.repair_action_id, { selectedEntryId: event.currentTarget.value })
                                }
                              >
                                <option value="">—</option>
                                {entries.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label className={styles.wide}>
                            <span>{gateCC4Copy.reason}</span>
                            <textarea
                              value={draft.reason}
                              required
                              minLength={3}
                              onChange={(event) =>
                                updateDraft(action.repair_action_id, { reason: event.currentTarget.value })
                              }
                            />
                          </label>
                        </div>
                      ) : null}

                      {firstForMatch && scheduleAdjustmentAllowed ? (
                        <fieldset className={styles.adjustments}>
                          <legend>{gateCC4Copy.unchanged}</legend>
                          <label>
                            <span>{gateCC4Copy.startsAt}</span>
                            <input
                              type="datetime-local"
                              value={draft.startsAt}
                              onChange={(event) =>
                                updateDraft(action.repair_action_id, { startsAt: event.currentTarget.value })
                              }
                            />
                          </label>
                          <label>
                            <span>{gateCC4Copy.endsAt}</span>
                            <input
                              type="datetime-local"
                              value={draft.endsAt}
                              onChange={(event) =>
                                updateDraft(action.repair_action_id, { endsAt: event.currentTarget.value })
                              }
                            />
                          </label>
                          <label>
                            <span>{gateCC4Copy.playingArea}</span>
                            <select
                              value={draft.playingAreaId}
                              onChange={(event) =>
                                updateDraft(action.repair_action_id, { playingAreaId: event.currentTarget.value })
                              }
                            >
                              <option value="">—</option>
                              {references.playing_areas.map((area) => (
                                <option key={area.id} value={area.id}>
                                  {area.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </fieldset>
                      ) : null}
                    </section>
                  );
                })}
              </div>

              <section className={styles.commands}>
                {unresolved.length ? <p role="status">{gateCC4Copy.publishBlocked}</p> : null}
                <div>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void saveRevision(gateCC4Machine.draft)}
                  >
                    {busy === gateCC4Machine.draft ? gateCC4Copy.saving : gateCC4Copy.saveDraft}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy) || unresolved.length > 0}
                    onClick={() => void saveRevision(gateCC4Machine.ready)}
                  >
                    {busy === gateCC4Machine.ready ? gateCC4Copy.saving : gateCC4Copy.markReady}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy) || !workspace.publication_ready}
                    onClick={() => void publish()}
                  >
                    {busy === gateCC4UiMachine.publishBusy ? gateCC4Copy.publishing : gateCC4Copy.publish}
                  </button>
                </div>
                <label>
                  <span>{gateCC4Copy.reason}</span>
                  <input
                    value={abandonReason}
                    minLength={3}
                    onChange={(event) => setAbandonReason(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={Boolean(busy) || abandonReason.trim().length < 3}
                  onClick={() => void abandon()}
                >
                  {busy === gateCC4UiMachine.abandonBusy ? gateCC4Copy.abandoning : gateCC4Copy.abandon}
                </button>
              </section>

              <section className={styles.exports}>
                <div>
                  <h2>{gateCC4Copy.schedulePdf}</h2>
                  <p>{gateCC4Copy.exportHelp}</p>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void exportPdf(
                        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/exports/schedule`,
                        gateCC4UiMachine.scheduleExportBusy,
                      )
                    }
                  >
                    {gateCC4Copy.schedulePdf}
                  </button>
                </div>
                <ul>
                  {matches.map((match) => (
                    <li key={match.id}>
                      <span>
                        <strong>{match.label}</strong>
                        <small>
                          {match.home} · {match.away}
                        </small>
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void exportPdf(
                            `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/exports/matches/${encodeURIComponent(match.id)}/score-sheet`,
                            `score-sheet-${match.id}`,
                          )
                        }
                      >
                        {gateCC4Copy.scoreSheet}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className={styles.audit}>
                <h2>{gateCC4Copy.audit}</h2>
                <ol>
                  {workspace.audit.map((entry) => (
                    <li key={`${entry.occurred_at}-${entry.target_id}-${entry.action}`}>
                      <time dateTime={entry.occurred_at}>{new Date(entry.occurred_at).toLocaleString()}</time>
                      <strong>{title(entry.action)}</strong>
                      <span>{entry.reason ?? entry.target_type}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : loading ? (
            <p role="status">{gateCC4Copy.loading}</p>
          ) : (
            <div className={styles.empty}>
              <h2>{gateCC4Copy.noRepairs}</h2>
              <p>{gateCC4Copy.noRepairsBody}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
