import type { EdgePurgeRequest } from "@matchday/edge-cache";
import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";

type OutboxRow = Readonly<{
  id: string;
  aggregate_id: string;
  payload: unknown;
  dispatch_claim_id: string;
}>;

export type PublicProjectionPurgeEnqueuer = Readonly<{
  enqueueEdgePurge(request: EdgePurgeRequest): Promise<unknown>;
}>;

export type PublicProjectionOutboxDispatcher = Readonly<{
  drainOnce(): Promise<number>;
  close(): Promise<void>;
}>;

type Payload = Readonly<{
  competition_id: string;
  projection: "results" | "schedule";
  previous_published_version: number;
  published_version: number;
  publication_state: "published";
  correlation_id: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reject malformed outbox data before it reaches the shared Redis worker queue. */
export function parsePublicProjectionOutboxPayload(value: unknown, aggregateId: string): Payload {
  const input = record(value);
  const competitionId = input?.competition_id;
  const projection = input?.projection;
  const previousPublishedVersion = input?.previous_published_version;
  const publishedVersion = input?.published_version;
  const publicationState = input?.publication_state;
  const correlationId = input?.correlation_id;
  if (
    !input ||
    typeof competitionId !== "string" ||
    competitionId !== aggregateId ||
    !UUID.test(competitionId) ||
    (projection !== "results" && projection !== "schedule") ||
    typeof previousPublishedVersion !== "number" ||
    !Number.isSafeInteger(previousPublishedVersion) ||
    previousPublishedVersion < 0 ||
    typeof publishedVersion !== "number" ||
    !Number.isSafeInteger(publishedVersion) ||
    publishedVersion < 1 ||
    publishedVersion <= previousPublishedVersion ||
    publicationState !== "published" ||
    typeof correlationId !== "string" ||
    !CORRELATION.test(correlationId)
  ) {
    throw new Error("Malformed public projection outbox payload");
  }
  return {
    competition_id: competitionId,
    projection,
    previous_published_version: previousPublishedVersion,
    published_version: publishedVersion,
    publication_state: publicationState,
    correlation_id: correlationId,
  };
}

export function createPublicProjectionOutboxDispatcher(
  input: Readonly<{
    databaseUrl: string;
    enqueuer: PublicProjectionPurgeEnqueuer;
    batchSize?: number;
    claimLeaseMs?: number;
    sql?: Sql;
  }>,
): PublicProjectionOutboxDispatcher {
  const ownsSql = input.sql === undefined;
  const sql = input.sql ?? postgres(input.databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  const batchSize = input.batchSize ?? 10;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Public projection outbox batch size must be an integer from 1 to 100");
  }
  const claimLeaseMs = input.claimLeaseMs ?? 30_000;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1_000 || claimLeaseMs > 300_000) {
    throw new Error("Public projection outbox claim lease must be an integer from 1000 to 300000");
  }
  let draining = false;

  async function releaseClaim(row: OutboxRow): Promise<void> {
    await sql`
      UPDATE outbox_events
      SET dispatch_claim_id=NULL,dispatch_claimed_at=NULL,dispatch_claim_expires_at=NULL,available_at=now()
      WHERE id=${row.id} AND dispatch_claim_id=${row.dispatch_claim_id} AND published_at IS NULL
    `;
  }

  return {
    async drainOnce(): Promise<number> {
      if (draining) return 0;
      draining = true;
      try {
        // PostgreSQL exposes the outbox row only after its publication
        // transaction commits. Commit a separate dispatch lease before the
        // external enqueue so Redis/edge latency never holds database locks,
        // and a stalled worker can be recovered after the lease expires.
        const rows = await sql.begin(async (transaction) => {
          const candidates = await transaction<Omit<OutboxRow, "dispatch_claim_id">[]>`
              SELECT id,aggregate_id,payload
              FROM outbox_events
              WHERE event_type='public_projection.published'
                AND published_at IS NULL
                AND available_at<=now()
                AND (dispatch_claim_expires_at IS NULL OR dispatch_claim_expires_at<=now())
              ORDER BY created_at,id
              FOR UPDATE SKIP LOCKED
              LIMIT ${batchSize}
            `;
          const claimed: OutboxRow[] = [];
          for (const candidate of candidates) {
            const claimId = randomUUID();
            await transaction`
                UPDATE outbox_events
                SET dispatch_claim_id=${claimId},dispatch_claimed_at=now(),
                    dispatch_claim_expires_at=now() + (${claimLeaseMs} * interval '1 millisecond'),
                    attempts=attempts+1
                WHERE id=${candidate.id} AND published_at IS NULL
              `;
            claimed.push({ ...candidate, dispatch_claim_id: claimId });
          }
          return claimed;
        });
        for (const row of rows) {
          try {
            const payload = parsePublicProjectionOutboxPayload(row.payload, row.aggregate_id);
            await input.enqueuer.enqueueEdgePurge({
              competitionId: payload.competition_id,
              projection: payload.projection,
              publicationState: payload.publication_state,
              previousPublishedVersion: payload.previous_published_version,
              publishedVersion: payload.published_version,
              correlationId: payload.correlation_id,
            });
            const acknowledged = await sql<{ id: string }[]>`
              UPDATE outbox_events
              SET published_at=now(),dispatch_claim_id=NULL,dispatch_claimed_at=NULL,dispatch_claim_expires_at=NULL
              WHERE id=${row.id} AND dispatch_claim_id=${row.dispatch_claim_id} AND published_at IS NULL
              RETURNING id
            `;
            if (acknowledged.length !== 1) {
              throw new Error("Public projection outbox claim expired before acknowledgement");
            }
          } catch (error) {
            // A timed-out enqueue may have reached Redis. Releasing is safe:
            // EdgePurge job ids are deterministic and therefore deduplicated
            // by the worker queue on a later claim.
            await releaseClaim(row);
            throw error;
          }
        }
        return rows.length;
      } finally {
        draining = false;
      }
    },
    async close(): Promise<void> {
      if (ownsSql) await sql.end({ timeout: 5 });
    },
  };
}
