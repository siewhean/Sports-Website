"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineQueueSummary,
  GateCOfflineQueuedCommand,
  GateCOfflineReplayError,
  GateCOfflineReplayReceipt,
} from "@matchday/contracts";
import { canonicalOfflineJson } from "@matchday/domain";
import type { OfflineReplayPort, OfflineScoringRepository } from "./offline-scoring";
import { scoringSessionView, ScoringTransportError, type ApiSessionState } from "./phase2-scoring";
import type { ScoringSessionView } from "./phase2";

export type OfflineAuthorityMetadata = Readonly<{
  principal_id: string;
  authorization_id: string;
  competition_id: string;
  match_id: string;
  generation: number;
  recording_expires_at: string;
  replay_expires_at: string;
  pass_expires_at: string;
  status: "active";
}>;

export type OfflineAuthorityResult = Readonly<{
  offline: OfflineAuthorityMetadata;
  session: ScoringSessionView | null;
}>;

export async function offlineQueueSummary(
  repository: OfflineScoringRepository,
  authorizationId: string,
): Promise<GateCOfflineQueueSummary> {
  const [matchPackage, commands, acknowledgements, pending] = await Promise.all([
    repository.getMatchPackage(authorizationId),
    repository.listCommands(authorizationId),
    repository.listAcknowledgements(authorizationId),
    repository.listPendingCommands(authorizationId),
  ]);
  if (!matchPackage) throw new Error("Offline match authorization is unavailable.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOfflineJson({ commands, acknowledgements })),
  );
  return {
    authorization_id: authorizationId,
    pending_count: pending.length,
    last_local_sequence: commands.at(-1)?.local_sequence ?? 0,
    last_acknowledged_sequence: acknowledgements.at(-1)?.aggregate_version ?? matchPackage.last_acknowledged_sequence,
    queue_fingerprint: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

export async function emptyOfflineQueueSummary(
  authorizationId: string,
  lastAcknowledgedSequence: number,
): Promise<GateCOfflineQueueSummary> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOfflineJson({ commands: [], acknowledgements: [] })),
  );
  return {
    authorization_id: authorizationId,
    pending_count: 0,
    last_local_sequence: 0,
    last_acknowledged_sequence: lastAcknowledgedSequence,
    queue_fingerprint: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

type SafeErrorEnvelope = {
  error?: string;
  code?: string;
  current_sequence?: number;
  current_aggregate_version?: number;
};

async function errorEnvelope(response: Response): Promise<SafeErrorEnvelope> {
  return (await response.json().catch(() => ({}))) as SafeErrorEnvelope;
}

function replayError(response: Response, envelope: SafeErrorEnvelope): GateCOfflineReplayError {
  const code =
    envelope.code === "STALE_WRITER_GENERATION"
      ? "stale_writer_generation"
      : envelope.code === "SCORE_VERSION_CONFLICT"
        ? "aggregate_version_conflict"
        : envelope.code === "IDEMPOTENCY_KEY_REUSED"
          ? "idempotency_key_reused"
          : envelope.code === "OFFLINE_AUTHORIZATION_EXPIRED" || envelope.code === "OFFLINE_RECORDING_EXPIRED"
            ? "authority_expired"
            : envelope.code === "OFFLINE_AUTHORIZATION_REVOKED"
              ? "authority_revoked"
              : envelope.code === "OFFLINE_AUTHORIZATION_TRANSFERRED"
                ? "authority_transferred"
                : envelope.code === "ACCESS_EXPIRED"
                  ? "pass_expired"
                  : response.status === 429
                    ? "rate_limited"
                    : response.status >= 500
                      ? "server_unavailable"
                      : "invalid_command";
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return {
    code,
    category:
      code === "rate_limited" || code === "server_unavailable"
        ? "retryable"
        : code === "invalid_command" || code === "idempotency_key_reused"
          ? "validation"
          : "conflict",
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retry_after_seconds: retryAfter } : {}),
  };
}

function authorityTransportError(response: Response, envelope: SafeErrorEnvelope): ScoringTransportError {
  const state =
    envelope.error === "conflict" ||
    envelope.error === "expired" ||
    envelope.error === "invalid" ||
    envelope.error === "rate_limited" ||
    envelope.error === "revoked"
      ? envelope.error
      : response.status === 400 || response.status === 401 || response.status === 403
        ? "access"
        : "unavailable";
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return new ScoringTransportError(
    state,
    Number.isFinite(retryAfter) ? retryAfter : null,
    typeof envelope.code === "string" ? envelope.code : null,
    Number.isSafeInteger(envelope.current_sequence) ? Number(envelope.current_sequence) : null,
    Number.isSafeInteger(envelope.current_aggregate_version) ? Number(envelope.current_aggregate_version) : null,
  );
}

function authorityMetadata(value: unknown): OfflineAuthorityMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.authorization_id !== "string" ||
    typeof source.principal_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(source.principal_id) ||
    typeof source.competition_id !== "string" ||
    typeof source.match_id !== "string" ||
    !Number.isSafeInteger(source.generation) ||
    typeof source.recording_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.recording_expires_at)) ||
    typeof source.replay_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.replay_expires_at)) ||
    typeof source.pass_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.pass_expires_at)) ||
    source.status !== "active"
  ) {
    return null;
  }
  return source as OfflineAuthorityMetadata;
}

export class ApiOfflineScoringPort implements OfflineReplayPort {
  constructor(
    private readonly deviceId: string,
    private readonly indexeddbSchemaVersion: number,
    private readonly serviceWorkerVersion: string,
  ) {}

  async establishAuthority(
    summary: GateCOfflineQueueSummary,
    intent: "prepare" | "resume" = "resume",
  ): Promise<OfflineAuthorityResult> {
    const response = await fetch("/api/scoring/offline/authority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        deviceId: this.deviceId,
        lastAcknowledgedSequence: summary.last_acknowledged_sequence,
        pendingEventCount: summary.pending_count,
        pendingThroughSequence: summary.last_acknowledged_sequence + summary.pending_count,
        lastReportedLocalSequence: summary.last_local_sequence,
        queueFingerprint: summary.queue_fingerprint,
        indexeddbSchemaVersion: this.indexeddbSchemaVersion,
        serviceWorkerVersion: this.serviceWorkerVersion,
        intent,
      }),
    });
    if (!response.ok) throw authorityTransportError(response, await errorEnvelope(response));
    const payload = (await response.json()) as { offline?: unknown; session?: unknown };
    const offline = authorityMetadata(payload.offline);
    if (!offline) throw new ScoringTransportError("unavailable");
    return {
      offline,
      session: payload.session ? scoringSessionView(payload.session as ApiSessionState) : null,
    };
  }

  async revokeAuthority(intent: "end_session" | "preparation_rollback" = "end_session"): Promise<void> {
    const response = await fetch("/api/scoring/offline/authority", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ deviceId: this.deviceId, intent }),
    });
    if (!response.ok) {
      throw authorityTransportError(response, await errorEnvelope(response));
    }
  }

  async submit(
    queued: GateCOfflineQueuedCommand,
    resolvedCommand: GateCOfflineQueuedCommand["command"],
    signal?: AbortSignal,
  ): Promise<GateCOfflineReplayReceipt> {
    try {
      const wire = Object.fromEntries(Object.entries(resolvedCommand).filter(([key]) => key !== "kind"));
      const response = await fetch(
        resolvedCommand.kind === "finalisation" ? "/api/scoring/finalise" : "/api/scoring/events",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(wire),
          signal,
        },
      );
      if (!response.ok) {
        const error = replayError(response, await errorEnvelope(response));
        return error.category === "retryable" ? { status: "retry", error } : { status: "blocked", error };
      }
      const source = (await response.json()) as Record<string, unknown>;
      const acknowledgement = this.acknowledgement(queued, source);
      return acknowledgement
        ? { status: "acknowledged", acknowledgement }
        : { status: "blocked", error: { code: "invalid_command", category: "validation" } };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        status: "retry",
        error: {
          code: typeof navigator !== "undefined" && !navigator.onLine ? "network_unavailable" : "server_unavailable",
          category: "retryable",
        },
      };
    }
  }

  private acknowledgement(
    queued: GateCOfflineQueuedCommand,
    source: Record<string, unknown>,
  ): GateCOfflineAcknowledgement | null {
    if (
      source.client_event_id !== queued.command.client_event_id ||
      typeof source.command_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.command_fingerprint) ||
      typeof source.duplicate !== "boolean" ||
      !Number.isSafeInteger(source.sequence) ||
      !Number.isSafeInteger(source.aggregate_version) ||
      typeof source.server_received_at !== "string" ||
      !Number.isFinite(Date.parse(source.server_received_at)) ||
      (source.event_id !== undefined && typeof source.event_id !== "string")
    ) {
      return null;
    }
    return {
      authorization_id: queued.authorization_id,
      match_id: queued.match_id,
      local_sequence: queued.local_sequence,
      client_event_id: queued.command.client_event_id,
      command_fingerprint: source.command_fingerprint,
      outcome: source.duplicate ? "duplicate" : "accepted",
      ...(typeof source.event_id === "string" ? { event_id: source.event_id } : {}),
      sequence: Number(source.sequence),
      aggregate_version: Number(source.aggregate_version),
      ...(Number.isSafeInteger(source.result_version) ? { result_version: Number(source.result_version) } : {}),
      ...(Number.isSafeInteger(source.publication_version)
        ? { publication_version: Number(source.publication_version) }
        : {}),
      server_received_at: source.server_received_at,
      acknowledged_at: new Date().toISOString(),
    };
  }
}
