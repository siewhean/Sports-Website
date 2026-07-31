"use client";

import { useCallback, useEffect, useState } from "react";
import { parseGateCC4Workspace } from "@/lib/gate-c-c4";
import { parseGateCC4PendingRepairCases, type GateCC4PendingRepairCase } from "@/lib/gate-c-c4-pending";
import styles from "./PendingRepairCases.module.css";

const copy = {
  title: "Corrections awaiting analysis",
  intro: "These private repair cases were created atomically with corrected public results.",
  empty: "No corrected result is waiting for affected-match analysis.",
  analyse: "Build affected-match workspace",
  analysing: "Building workspace",
  failed: "Pending repair cases could not be loaded.",
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(payload: unknown): string {
  return record(payload) && record(payload.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : copy.failed;
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
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs/pending`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? parseGateCC4PendingRepairCases(payload) : null;
      if (!parsed) throw new Error(errorMessage(payload));
      setItems(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.failed);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function analyse(item: GateCC4PendingRepairCase) {
    if (busy) return;
    setBusy(item.result_repair_case_id);
    setError("");
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/repairs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ correction_transaction_id: item.correction_transaction_id }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !parseGateCC4Workspace(payload)) throw new Error(errorMessage(payload));
      await load();
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="gate-c-c4-pending-title">
      <header>
        <div>
          <h2 id="gate-c-c4-pending-title">{copy.title}</h2>
          <p>{copy.intro}</p>
        </div>
        <span aria-live="polite">{loading ? "Loading" : `${items.length} pending`}</span>
      </header>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {!loading && items.length === 0 ? <p className={styles.empty}>{copy.empty}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.result_repair_case_id}>
            <div>
              <strong>{item.corrected_match_code}</strong>
              <span>{item.division_name} · result version {item.source_result_version}</span>
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
            </div>
            <button type="button" disabled={Boolean(busy)} onClick={() => void analyse(item)}>
              {busy === item.result_repair_case_id ? copy.analysing : copy.analyse}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
