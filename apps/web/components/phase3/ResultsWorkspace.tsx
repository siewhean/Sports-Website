"use client";

import { useState } from "react";
import {
  ArrowClockwise,
  ArrowsDownUp,
  CheckCircle,
  ClockCounterClockwise,
  LockKey,
  ShieldWarning,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  entryCountLabel,
  formatResultsTimestamp,
  metricLabel,
  parseRecalculationResponse,
  phase3ResultsCopy,
  phase3ResultsMachine,
  resultVersionLabel,
  shortHash,
  sportNameFromConfig,
  type ResultsDocument,
  type ResultsSurfaceState,
  type StandingsRow,
} from "@/lib/phase3-results";
import type { MatchView } from "@/lib/phase2";
import { OrganiserResultOperations } from "@/components/phase5/OrganiserResultOperations";
import styles from "./ResultsWorkspace.module.css";

const stateCopy: Record<
  Exclude<ResultsSurfaceState, "ready" | "read-only" | "loading">,
  { title: string; body: string }
> = {
  empty: { title: phase3ResultsCopy.noStandings, body: phase3ResultsCopy.noStandingsBody },
  error: { title: phase3ResultsCopy.error, body: phase3ResultsCopy.errorBody },
  offline: { title: phase3ResultsCopy.offline, body: phase3ResultsCopy.offlineBody },
  permission: { title: phase3ResultsCopy.permission, body: phase3ResultsCopy.permissionBody },
};

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function entryName(rows: readonly StandingsRow[], entryId: string | null): string {
  if (!entryId) return phase3ResultsCopy.unassigned;
  return rows.find((row) => row.entryId === entryId)?.entryName ?? shortHash(entryId);
}

export function ResultsWorkspace({
  document,
  matches,
  initialMatchId,
  enableRemoteOperations,
}: {
  document: ResultsDocument;
  matches: readonly MatchView[];
  initialMatchId?: string;
  enableRemoteOperations: boolean;
}) {
  const [snapshot, setSnapshot] = useState(document.snapshot);
  const [advancement, setAdvancement] = useState(document.advancement);
  const [state, setState] = useState(document.state);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [commandError, setCommandError] = useState("");
  const groups = snapshot ? Object.entries(snapshot.groups) : [];
  const allRows = groups.flatMap(([, group]) => group.rows);
  const stale = Boolean(snapshot && document.currentResultVersion > snapshot.resultVersion);
  const resultOperations = (
    <OrganiserResultOperations
      competitionId={document.competitionId}
      matches={matches}
      initialMatchId={initialMatchId}
      enableRemote={enableRemoteOperations}
    />
  );

  async function recalculate() {
    if (!document.canRecalculate || busy) return;
    setBusy(true);
    setCommandError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/phase3/competitions/${encodeURIComponent(document.competitionId)}/divisions/${encodeURIComponent(document.divisionId)}/standings`,
        { method: phase3ResultsMachine.post },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setState(phase3ResultsMachine.permission);
        else if (response.status === 409) setCommandError(phase3ResultsCopy.noStandingsBody);
        else setCommandError(phase3ResultsCopy.errorBody);
        return;
      }
      const parsed = parseRecalculationResponse(payload, document.competitionId, document.divisionId);
      if (!parsed) {
        setCommandError(phase3ResultsCopy.malformed);
        return;
      }
      setSnapshot(parsed.snapshot);
      setAdvancement({
        status: phase3ResultsMachine.recalculated,
        slots: [],
        changes: parsed.changes,
        conflicts: parsed.conflicts,
      });
      setState(phase3ResultsMachine.ready);
      setMessage(phase3ResultsCopy.recalculated);
    } catch {
      setState(phase3ResultsMachine.offline);
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <ResultsSkeleton />;
  if (state === "permission") {
    const copy = stateCopy[state as keyof typeof stateCopy] ?? stateCopy.error;
    return <ResultsState state={state} title={copy.title} body={copy.body} />;
  }
  if (state !== "ready" && state !== "read-only" && !snapshot) {
    const copy = stateCopy[state as keyof typeof stateCopy] ?? stateCopy.error;
    return (
      <>
        <ResultsState state={state} title={copy.title} body={copy.body} />
        {resultOperations}
      </>
    );
  }
  if (!snapshot)
    return (
      <>
        <ResultsState
          state={phase3ResultsMachine.empty}
          title={phase3ResultsCopy.noStandings}
          body={phase3ResultsCopy.noStandingsBody}
        />
        {resultOperations}
      </>
    );

  const sportName = sportNameFromConfig(snapshot.configVersion);
  return (
    <div className={styles.workspace} data-testid="phase3-results">
      <p className={styles.live} aria-live="polite">
        {message}
      </p>
      <section className={styles.main} aria-label={phase3ResultsCopy.calculatedStandings}>
        {state === "read-only" ? (
          <div className={styles.boundary} role="note">
            <LockKey aria-hidden="true" />
            <div>
              <strong>{phase3ResultsCopy.readOnly}</strong>
              <p>{phase3ResultsCopy.readOnlyBody}</p>
            </div>
          </div>
        ) : null}
        {stale ? (
          <div className={styles.stale} role="alert">
            <ClockCounterClockwise aria-hidden="true" />
            <div>
              <strong>{phase3ResultsCopy.stale}</strong>
              <p>{phase3ResultsCopy.staleBody}</p>
            </div>
          </div>
        ) : null}
        {commandError ? (
          <p className={styles.commandError} role="alert">
            <WarningCircle aria-hidden="true" />
            {commandError}
          </p>
        ) : null}

        <header className={styles.tableHeading}>
          <div>
            <p>
              {sportName} · {document.divisionName}
            </p>
            <h2>{phase3ResultsCopy.calculatedTables}</h2>
            <span>{phase3ResultsCopy.calculatedTablesBody}</span>
          </div>
          <button
            className={styles.recalculate}
            type="button"
            disabled={!document.canRecalculate || busy}
            onClick={() => void recalculate()}
          >
            <ArrowClockwise aria-hidden="true" />
            {busy ? phase3ResultsCopy.recalculating : phase3ResultsCopy.recalculate}
          </button>
        </header>

        <div className={styles.groups}>
          {groups.map(([groupId, group]) => (
            <section className={styles.group} key={groupId} aria-labelledby={`standings-${groupId}`}>
              <header>
                <h3 id={`standings-${groupId}`}>{groupId.replaceAll("-", " ")}</h3>
                <span>{entryCountLabel(group.rows.length)}</span>
              </header>
              <div
                className={styles.tableScroll}
                tabIndex={0}
                role="region"
                aria-label={`${groupId.replaceAll("-", " ")} standings table`}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.rank}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.entry}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.record}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.score}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.difference}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.points}</th>
                      <th scope={phase3ResultsMachine.columnScope}>{phase3ResultsCopy.rankBasis}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => (
                      <StandingsTableRow row={row} key={row.entryId} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>

        <section className={styles.advancement} aria-labelledby="advancement-title">
          <header>
            <div>
              <p>{phase3ResultsCopy.qualifierLineage}</p>
              <h2 id="advancement-title">{phase3ResultsCopy.advancement}</h2>
            </div>
            <ArrowsDownUp aria-hidden="true" />
          </header>
          {advancement.status === "not-returned" ? (
            <div className={styles.contractBoundary} role="note">
              <ShieldWarning aria-hidden="true" />
              <div>
                <strong>{phase3ResultsCopy.advancementUnavailable}</strong>
                <p>{phase3ResultsCopy.advancementUnavailableBody}</p>
              </div>
            </div>
          ) : (
            <div className={styles.decisionColumns}>
              <section aria-labelledby="automatic-title">
                <h3 id="automatic-title">{phase3ResultsCopy.automatic}</h3>
                {advancement.status === phase3ResultsMachine.persisted ? (
                  advancement.slots.filter((slot) => slot.control === "automatic").length ? (
                    <ol>
                      {advancement.slots
                        .filter((slot) => slot.control === "automatic")
                        .map((slot) => (
                          <li key={`${slot.matchId}-${slot.slot}`}>
                            <CheckCircle aria-hidden="true" />
                            <span>
                              <strong>{entryName(allRows, slot.entryId)}</strong>
                              <small title={`${slot.matchId}:${slot.slot}`}>
                                {shortHash(slot.matchId)}:{slot.slot} · {slot.controlledByRuleId} ·{" "}
                                {slot.sourceFingerprint
                                  ? shortHash(slot.sourceFingerprint)
                                  : phase3ResultsCopy.waitingSource}
                              </small>
                            </span>
                          </li>
                        ))}
                    </ol>
                  ) : (
                    <p>{phase3ResultsCopy.noChanges}</p>
                  )
                ) : advancement.changes.length ? (
                  <ol>
                    {advancement.changes.map((change) => (
                      <li key={`${change.slotId}-${change.entryId}`}>
                        <CheckCircle aria-hidden="true" />
                        <span>
                          <strong>{change.slotId}</strong>
                          <small>
                            {entryName(allRows, change.previousEntryId)} → {entryName(allRows, change.entryId)}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{phase3ResultsCopy.noChanges}</p>
                )}
              </section>
              <section
                className={advancement.conflicts.length ? styles.hasConflict : undefined}
                aria-labelledby="conflict-title"
              >
                <h3 id="conflict-title">{phase3ResultsCopy.protected}</h3>
                {advancement.status === phase3ResultsMachine.persisted &&
                advancement.slots.some((slot) => slot.control === phase3ResultsMachine.manual) ? (
                  <ol>
                    {advancement.slots
                      .filter((slot) => slot.control === phase3ResultsMachine.manual)
                      .map((slot) => (
                        <li key={`${slot.matchId}-${slot.slot}`}>
                          <LockKey aria-hidden="true" />
                          <span>
                            <strong>{entryName(allRows, slot.entryId)}</strong>
                            <small title={`${slot.matchId}:${slot.slot}`}>
                              {shortHash(slot.matchId)}:{slot.slot} · {phase3ResultsCopy.organiserControlled}
                            </small>
                          </span>
                        </li>
                      ))}
                    {advancement.conflicts.map((conflict) => (
                      <li key={`${conflict.ruleId}-${conflict.targetSlotId}-${conflict.reason}`}>
                        <WarningCircle aria-hidden="true" />
                        <span>
                          <strong>{phase3ResultsCopy.conflict}</strong>
                          <small title={conflict.targetSlotId}>
                            {shortHash(conflict.targetSlotId)} · {metricLabel(conflict.reason)}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : advancement.conflicts.length ? (
                  <ol>
                    {advancement.conflicts.map((conflict) => (
                      <li key={`${conflict.ruleId}-${conflict.targetSlotId}-${conflict.reason}`}>
                        <WarningCircle aria-hidden="true" />
                        <span>
                          <strong>{phase3ResultsCopy.conflict}</strong>
                          <small title={conflict.targetSlotId}>
                            {shortHash(conflict.targetSlotId)} · {metricLabel(conflict.reason)}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{phase3ResultsCopy.noConflicts}</p>
                )}
              </section>
            </div>
          )}
        </section>
        {resultOperations}
      </section>

      <aside className={styles.rail} aria-label={phase3ResultsCopy.provenance}>
        <div className={styles.serverOwned}>
          <CheckCircle weight="fill" aria-hidden="true" />
          <span>{phase3ResultsCopy.sourceOwned}</span>
        </div>
        <h2>{phase3ResultsCopy.evidence}</h2>
        <dl>
          <div>
            <dt>{phase3ResultsCopy.resultVersion}</dt>
            <dd>{resultVersionLabel(snapshot.resultVersion)}</dd>
          </div>
          <div>
            <dt>{phase3ResultsCopy.calculation}</dt>
            <dd>{snapshot.configVersion}</dd>
          </div>
          <div>
            <dt>{phase3ResultsCopy.settings}</dt>
            <dd>{snapshot.settingsVersion}</dd>
          </div>
          <div>
            <dt>{phase3ResultsCopy.source}</dt>
            <dd title={snapshot.sourceResultHash}>{shortHash(snapshot.sourceResultHash)}</dd>
          </div>
          <div>
            <dt>{phase3ResultsCopy.snapshot}</dt>
            <dd title={snapshot.snapshotFingerprint}>{shortHash(snapshot.snapshotFingerprint)}</dd>
          </div>
          <div>
            <dt>{phase3ResultsCopy.calculatedAt}</dt>
            <dd>{formatResultsTimestamp(snapshot.createdAt)}</dd>
          </div>
        </dl>
        <p className={styles.evidenceNote}>{phase3ResultsCopy.evidenceBody}</p>
      </aside>
    </div>
  );
}

function StandingsTableRow({ row }: { row: StandingsRow }) {
  return (
    <tr className={row.sportingTie || row.status === "withdrawn" ? styles.attentionRow : undefined}>
      <td>
        <strong>{row.rank}</strong>
      </td>
      <th scope={phase3ResultsMachine.rowScope}>
        <span>{row.entryName}</span>
        {row.status === "withdrawn" ? <small>{phase3ResultsCopy.withdrawn}</small> : null}
        {!row.eligibleForAdvancement ? <small>{phase3ResultsCopy.ineligible}</small> : null}
      </th>
      <td>
        {row.won}–{row.drawn}–{row.lost}
      </td>
      <td>
        {row.scoreFor}–{row.scoreAgainst}
      </td>
      <td>{signed(row.scoreDifference)}</td>
      <td>
        <strong>{row.tablePoints}</strong>
      </td>
      <td>
        <details className={styles.explanation}>
          <summary>{metricLabel(row.resolvedBy)}</summary>
          <div>
            <strong>{phase3ResultsCopy.explanation}</strong>
            {row.sportingTie ? <p>{phase3ResultsCopy.tie}</p> : null}
            <ol>
              {row.explanations.map((explanation, index) => (
                <li key={`${explanation.criterion}-${index}`}>
                  <span>{metricLabel(explanation.criterion)}</span>
                  <p>{explanation.summary}</p>
                </li>
              ))}
            </ol>
          </div>
        </details>
      </td>
    </tr>
  );
}

function ResultsState({ state, title, body }: { state: ResultsSurfaceState; title: string; body: string }) {
  return (
    <section className={styles.state} data-state={state} aria-labelledby="results-state-title">
      <WarningCircle aria-hidden="true" />
      <p>{phase3ResultsCopy.service}</p>
      <h2 id="results-state-title">{title}</h2>
      <span>{body}</span>
    </section>
  );
}

function ResultsSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label={phase3ResultsCopy.loading}>
      <span className={styles.skeletonHeading} />
      <span className={styles.skeletonLine} />
      {Array.from({ length: 6 }, (_, index) => (
        <span className={styles.skeletonRow} key={index} />
      ))}
    </div>
  );
}
