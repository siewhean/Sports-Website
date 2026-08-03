"use client";

import { useCallback, useEffect, useState } from "react";
import { parseGateCC4Workspace } from "@/lib/gate-c-c4";
import { gateCC4Http, gateCC4UiMachine } from "@/lib/gate-c-c4-http";
import { gateCC4PendingCopy } from "@/lib/gate-c-c4-pending-copy";
import { parseGateCC4PendingRepairCases, type GateCC4PendingRepairCase } from "@/lib/gate-c-c4-pending";
import styles from "./PendingRepairCases.module.css";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(payload: unknown): string {
  return record(payload) && record(payload.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : gateCC4PendingCopy.failed;
}

export function PendingRepairCases({ competitionId }: { competitionId: string }) {
  const [items, setItems] = useState<GateCC4PendingRepairCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/pending`, {
        cache: gateCC4Http.cacheNoStore,
      });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? parseGateCC4PendingRepairCases(payload) : null;
      if (!parsed) throw new Error(errorMessage(payload));
      setItems(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4PendingCopy.failed);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function analyse(item: GateCC4PendingRepairCase) {
    if (busy) return;
    setBusy(item.result_repair_case_id);
    setError("");
    try {
      const response = await fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs`, {
        method: gateCC4Http.methodPost,
        headers: { "content-type": gateCC4Http.jsonContentType },
        body: JSON.stringify({ correction_transaction_id: item.correction_transaction_id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const workspace = response.ok ? parseGateCC4Workspace(payload) : null;
      if (!workspace) throw new Error(errorMessage(payload));
      await load();
      window.dispatchEvent(
        new CustomEvent(gateCC4UiMachine.repairCreatedEvent, {
          detail: { repairId: workspace.repair.repair_id },
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : gateCC4PendingCopy.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="gate-c-c4-pending-title">
      <header>
        <div>
          <h2 id="gate-c-c4-pending-title">{gateCC4PendingCopy.title}</h2>
          <p>{gateCC4PendingCopy.intro}</p>
        </div>
        <span aria-live="polite">
          {loading ? gateCC4PendingCopy.analysing : `${items.length} ${gateCC4PendingCopy.pending}`}
        </span>
      </header>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {!loading && items.length === 0 ? <p className={styles.empty}>{gateCC4PendingCopy.empty}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.result_repair_case_id}>
            <div>
              <strong>{item.corrected_match_code}</strong>
              <span>
                {item.division_name} · {gateCC4PendingCopy.resultVersion} {item.source_result_version}
              </span>
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
            </div>
            <button type="button" disabled={Boolean(busy)} onClick={() => void analyse(item)}>
              {busy === item.result_repair_case_id ? gateCC4PendingCopy.analysing : gateCC4PendingCopy.analyse}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
