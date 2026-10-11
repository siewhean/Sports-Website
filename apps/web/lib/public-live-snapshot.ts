/**
 * Client side of public live updates. The snapshot fetch itself lives in `lib/public-snapshot.ts` (CDN-cached
 * JSON with ETag revalidation); this module re-exports it for the spectator UI and adds the pure connection-status
 * derivation.
 */
export { fetchPublicSnapshot, publicSnapshotPath, type PublicSnapshotResult } from "@/lib/public-snapshot";

export type LiveConnection = "connecting" | "live" | "reconnecting" | "offline" | "paused";

export type LiveStatusInput = Readonly<{
  enabled: boolean;
  online: boolean;
  /** Last time the stream or a snapshot request answered. */
  lastContactAt: number | null;
  /** Last time fresh data was confirmed (a new snapshot or a 304). */
  lastSyncedAt: number | null;
  now: number;
}>;

/** A connection is only "live" while we have heard from the server recently; otherwise say so plainly. */
export const liveContactTimeoutMs = 20_000;

export function liveConnection(input: LiveStatusInput): LiveConnection {
  if (!input.enabled) return "paused";
  if (!input.online) return "offline";
  if (input.lastContactAt === null || input.lastSyncedAt === null) return "connecting";
  return input.now - input.lastContactAt <= liveContactTimeoutMs ? "live" : "reconnecting";
}
