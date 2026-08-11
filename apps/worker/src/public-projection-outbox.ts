import type { EdgePurgeRequest } from "@matchday/edge-cache";
import postgres, { type Sql } from "postgres";

type OutboxRow = Readonly<{
  id: string;
  aggregate_id: string;
  payload: unknown;
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
    sql?: Sql;
  }>,
): PublicProjectionOutboxDispatcher {
  const ownsSql = input.sql === undefined;
  const sql = input.sql ?? postgres(input.databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  const batchSize = input.batchSize ?? 10;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Public projection outbox batch size must be an integer from 1 to 100");
  }
  let draining = false;
  return {
    async drainOnce(): Promise<number> {
      if (draining) return 0;
      draining = true;
      try {
        return await sql.begin(async (transaction) => {
          const rows = await transaction<OutboxRow[]>`
            SELECT id,aggregate_id,payload
            FROM outbox_events
            WHERE event_type='public_projection.published' AND published_at IS NULL AND available_at<=now()
            ORDER BY created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchSize}
          `;
          for (const row of rows) {
            const payload = parsePublicProjectionOutboxPayload(row.payload, row.aggregate_id);
            await input.enqueuer.enqueueEdgePurge({
              competitionId: payload.competition_id,
              projection: payload.projection,
              publicationState: payload.publication_state,
              previousPublishedVersion: payload.previous_published_version,
              publishedVersion: payload.published_version,
              correlationId: payload.correlation_id,
            });
            await transaction`
              UPDATE outbox_events
              SET published_at=now(),attempts=attempts+1
              WHERE id=${row.id} AND published_at IS NULL
            `;
          }
          return rows.length;
        });
      } finally {
        draining = false;
      }
    },
    async close(): Promise<void> {
      if (ownsSql) await sql.end({ timeout: 5 });
    },
  };
}
