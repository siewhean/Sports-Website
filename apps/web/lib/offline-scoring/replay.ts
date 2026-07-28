"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineQueuedCommand,
  GateCOfflineReplayError,
} from "@matchday/contracts";
import { canReplayOfflineCommand, resolveOfflineCommandForReplay } from "@matchday/domain";
import type { OfflineReplayPort, OfflineScoringRepository } from "./types";

const LEASE_TTL_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export type OfflineReplayResult = Readonly<{
  status: "complete" | "blocked" | "busy" | "offline";
  acknowledged: number;
  error?: GateCOfflineReplayError;
}>;

type ReplayDependencies = Readonly<{
  repository: OfflineScoringRepository;
  port: OfflineReplayPort;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  isOnline?: () => boolean;
  lockManager?: Pick<LockManager, "request"> | null;
}>;

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function browserLockManager(): Pick<LockManager, "request"> | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

export class OfflineReplayController {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly isOnline: () => boolean;
  private readonly lockManager: Pick<LockManager, "request"> | null;

  constructor(private readonly dependencies: ReplayDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? wait;
    this.isOnline = dependencies.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine);
    this.lockManager = dependencies.lockManager === undefined ? browserLockManager() : dependencies.lockManager;
  }

  async replay(authorizationId: string, signal?: AbortSignal): Promise<OfflineReplayResult> {
    signal?.throwIfAborted();
    const ownerId = crypto.randomUUID();
    const execute = () => this.replayWithLease(authorizationId, ownerId, signal);
    if (!this.lockManager) return execute();

    let result: OfflineReplayResult = { status: "busy", acknowledged: 0 };
    await this.lockManager.request(
      `matchday-offline-replay:${authorizationId}`,
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        if (lock) {
          signal?.throwIfAborted();
          result = await execute();
        }
      },
    );
    return result;
  }

  private async replayWithLease(
    authorizationId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<OfflineReplayResult> {
    const epoch = await this.dependencies.repository.acquireReplayLease(
      authorizationId,
      ownerId,
      this.now(),
      LEASE_TTL_MS,
    );
    if (epoch === null) return { status: "busy", acknowledged: 0 };

    let acknowledgedCount = 0;
    try {
      while (!signal?.aborted) {
        if (!this.isOnline()) return { status: "offline", acknowledged: acknowledgedCount };
        const matchPackage = await this.dependencies.repository.getMatchPackage(authorizationId);
        if (!matchPackage) {
          return {
            status: "blocked",
            acknowledged: acknowledgedCount,
            error: { code: "storage_corrupt", category: "storage" },
          };
        }
        const pending = await this.dependencies.repository.listPendingCommands(authorizationId);
        if (pending.length === 0) return { status: "complete", acknowledged: acknowledgedCount };
        if (matchPackage.status === "completed") {
          return {
            status: "blocked",
            acknowledged: acknowledgedCount,
            error: { code: "storage_corrupt", category: "storage" },
          };
        }
        if (!canReplayOfflineCommand(matchPackage, this.now())) {
          const code =
            matchPackage.status === "revoked"
              ? "authority_revoked"
              : matchPackage.status === "transferred"
                ? "authority_transferred"
                : this.now() >= Date.parse(matchPackage.pass_expires_at)
                  ? "pass_expired"
                  : "authority_expired";
          if (matchPackage.status === "active") {
            await this.dependencies.repository.transitionMatchPackageStatus(authorizationId, "expired");
          }
          return {
            status: "blocked",
            acknowledged: acknowledgedCount,
            error: { code, category: "permission" },
          };
        }
        const queued = pending[0];
        if (!queued) return { status: "complete", acknowledged: acknowledgedCount };

        const leaseRenewed = await this.dependencies.repository.renewReplayLease(
          authorizationId,
          ownerId,
          epoch,
          this.now(),
          LEASE_TTL_MS,
        );
        if (!leaseRenewed) return { status: "busy", acknowledged: acknowledgedCount };

        const acknowledgements = await this.dependencies.repository.listAcknowledgements(authorizationId);
        let resolved: GateCOfflineQueuedCommand["command"];
        try {
          resolved = resolveOfflineCommandForReplay(queued, acknowledgements);
        } catch {
          const error = { code: "missing_reversal_target", category: "conflict" } as const;
          await this.recordBlocked(queued, error);
          return { status: "blocked", acknowledged: acknowledgedCount, error };
        }

        let commandAcknowledged = false;
        let authorityRefreshAttempted = false;
        for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
          if (attempt > 1) {
            const retryLeaseRenewed = await this.dependencies.repository.renewReplayLease(
              authorizationId,
              ownerId,
              epoch,
              this.now(),
              LEASE_TTL_MS,
            );
            if (!retryLeaseRenewed) return { status: "busy", acknowledged: acknowledgedCount };
          }
          const startedAt = new Date(this.now()).toISOString();
          const receipt = await this.dependencies.port.submit(queued, resolved, signal);
          const completedAt = new Date(this.now()).toISOString();
          const responseLeaseRenewed = await this.dependencies.repository.renewReplayLease(
            authorizationId,
            ownerId,
            epoch,
            this.now(),
            LEASE_TTL_MS,
          );
          if (!responseLeaseRenewed) return { status: "busy", acknowledged: acknowledgedCount };
          await this.dependencies.repository.appendReplayAttempt({
            authorization_id: authorizationId,
            local_sequence: queued.local_sequence,
            attempt,
            started_at: startedAt,
            completed_at: completedAt,
            outcome: receipt.status === "acknowledged" ? "acknowledged" : receipt.status,
            ...(receipt.status === "acknowledged" ? {} : { error: receipt.error }),
          });

          if (receipt.status === "acknowledged") {
            await this.dependencies.repository.appendAcknowledgement(receipt.acknowledgement);
            acknowledgedCount += 1;
            if (queued.command.kind === "finalisation") {
              await this.dependencies.repository.transitionMatchPackageStatus(authorizationId, "completed");
              return { status: "complete", acknowledged: acknowledgedCount };
            }
            commandAcknowledged = true;
            break;
          }
          if (
            receipt.status === "blocked" &&
            receipt.error.code === "stale_writer_generation" &&
            !authorityRefreshAttempted &&
            this.dependencies.port.refreshAuthority
          ) {
            authorityRefreshAttempted = true;
            const refreshed = await this.dependencies.port.refreshAuthority(authorizationId).catch(() => null);
            if (refreshed === "active") continue;
            if (refreshed) {
              const refreshError: GateCOfflineReplayError = {
                code: refreshed,
                category: refreshed === "authority_transferred" ? "conflict" : "permission",
              };
              await this.recordBlocked(queued, refreshError);
              return { status: "blocked", acknowledged: acknowledgedCount, error: refreshError };
            }
          }
          if (receipt.status === "blocked") {
            await this.recordBlocked(queued, receipt.error);
            return { status: "blocked", acknowledged: acknowledgedCount, error: receipt.error };
          }
          if (!this.isOnline()) return { status: "offline", acknowledged: acknowledgedCount };
          signal?.throwIfAborted();
          const retryAfter = Math.max(0, Math.min(30_000, (receipt.error.retry_after_seconds ?? 0) * 1_000));
          if (attempt <= RETRY_DELAYS_MS.length) {
            await this.sleep(Math.max(RETRY_DELAYS_MS[attempt - 1] ?? 16_000, retryAfter), signal);
          }
        }
        if (!commandAcknowledged) {
          return {
            status: "blocked",
            acknowledged: acknowledgedCount,
            error: { code: "server_unavailable", category: "retryable" },
          };
        }
      }
      return { status: "offline", acknowledged: acknowledgedCount };
    } finally {
      await this.dependencies.repository.releaseReplayLease(authorizationId, ownerId, epoch);
    }
  }

  private async recordBlocked(queued: GateCOfflineQueuedCommand, error: GateCOfflineReplayError): Promise<void> {
    if (error.code === "network_unavailable" || error.code === "rate_limited" || error.code === "server_unavailable") {
      return;
    }
    const terminalStatus =
      error.code === "authority_revoked"
        ? "revoked"
        : error.code === "authority_transferred"
          ? "transferred"
          : error.code === "authority_expired" || error.code === "pass_expired"
            ? "expired"
            : null;
    if (terminalStatus) {
      await this.dependencies.repository.transitionMatchPackageStatus(queued.authorization_id, terminalStatus);
    }
    await this.dependencies.repository.appendConflict({
      authorization_id: queued.authorization_id,
      match_id: queued.match_id,
      local_sequence: queued.local_sequence,
      client_event_id: queued.command.client_event_id,
      code: error.code,
      writer_generation: queued.writer_generation,
      recorded_at: new Date(this.now()).toISOString(),
    });
  }
}

export function acknowledgedSequences(acknowledgements: readonly GateCOfflineAcknowledgement[]): Set<number> {
  return new Set(acknowledgements.map(({ local_sequence }) => local_sequence));
}
