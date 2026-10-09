"use client";

import { interpolate, opaqueId, spectatorMessages as copy } from "@matchday/ui";
import type { PublicCompetitionPhase } from "@/lib/phase2-public-phase";
import { formatClock } from "@/lib/public-competition-model";
import type { LiveConnection } from "@/lib/public-live-snapshot";
import { publicUi, type LiveTone } from "@/lib/public-ui-tokens";
import styles from "./PublicCompetition.module.css";

/**
 * The single connection indicator for spectator pages. It never claims "live" without recent contact, and a
 * finished competition simply shows when it was last updated.
 */
export function liveStatusText(
  connection: LiveConnection,
  phase: PublicCompetitionPhase,
  time: string,
): Readonly<{ tone: LiveTone; text: string }> {
  if (phase === "completed" || connection === "paused")
    return { tone: opaqueId("idle"), text: interpolate(copy.status.paused, { time }) };
  if (connection === "live") return { tone: opaqueId("live"), text: interpolate(copy.status.live, { time }) };
  if (connection === "connecting") return { tone: opaqueId("idle"), text: copy.status.connecting };
  if (connection === "offline") return { tone: opaqueId("warn"), text: interpolate(copy.status.offline, { time }) };
  return { tone: opaqueId("warn"), text: interpolate(copy.status.reconnecting, { time }) };
}

export function LiveStatus({
  connection,
  phase,
  lastSyncedAt,
  fallbackLabel,
  timezone,
}: {
  connection: LiveConnection;
  phase: PublicCompetitionPhase;
  lastSyncedAt: number | null;
  fallbackLabel: string;
  timezone: string;
}) {
  const time = lastSyncedAt === null ? fallbackLabel : formatClock(new Date(lastSyncedAt), timezone, publicUi.locale);
  const status = liveStatusText(connection, phase, time);
  return (
    <p className={styles.liveStatus} data-tone={status.tone} data-connection={connection}>
      <span aria-hidden="true" />
      {status.text}
    </p>
  );
}
