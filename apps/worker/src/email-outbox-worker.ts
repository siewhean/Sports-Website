import { randomUUID } from "node:crypto";
import {
  createNodemailerSmtpEmailProvider,
  EmailOutboxProcessor,
  PostgresNotificationRepository,
  type EmailOutboxProcessingResult,
  type SmtpEmailProviderConfig,
} from "@matchday/notifications";
import postgres, { type Sql } from "postgres";

export const EMAIL_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;
export const EMAIL_DATABASE_STATEMENT_TIMEOUT_MS = 10_000;
export const EMAIL_DATABASE_CLOSE_TIMEOUT_SECONDS = 5;

export type EmailOutboxProcessorPort = {
  processDue(limit: number): Promise<EmailOutboxProcessingResult>;
};

export type EmailOutboxPollingWorkerOptions = {
  processor: EmailOutboxProcessorPort;
  pollIntervalMs: number;
  batchSize: number;
  onProcessed?: ((result: EmailOutboxProcessingResult) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
};

/**
 * Owns the bounded polling loop for the transactional email outbox. The
 * processor handles retries and dead-lettering; this loop only coordinates
 * durable claims and makes shutdown wait for an in-flight batch.
 */
export class EmailOutboxPollingWorker {
  readonly #processor: EmailOutboxProcessorPort;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #onProcessed?: ((result: EmailOutboxProcessingResult) => void) | undefined;
  readonly #onError?: ((error: unknown) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopping = false;
  #inFlight: Promise<void> | undefined;

  constructor(options: EmailOutboxPollingWorkerOptions) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1_000) {
      throw new Error("Email outbox poll interval must be at least 1000ms");
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
      throw new Error("Email outbox batch size must be a positive integer");
    }
    this.#processor = options.processor;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#batchSize = options.batchSize;
    this.#onProcessed = options.onProcessed;
    this.#onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.#stopping || this.#timer !== undefined || this.#inFlight !== undefined) return;
    await this.#processAndSchedule();
  }

  requestStop(): void {
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  async stop(): Promise<void> {
    this.requestStop();
    await this.#inFlight;
  }

  #processAndSchedule(): Promise<void> {
    const run = (async () => {
      try {
        const result = await this.#processor.processDue(this.#batchSize);
        this.#onProcessed?.(result);
      } catch (error) {
        this.#onError?.(error);
      } finally {
        this.#inFlight = undefined;
      }
      if (!this.#stopping) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.#processAndSchedule();
        }, this.#pollIntervalMs);
        this.#timer.unref();
      }
    })();
    this.#inFlight = run;
    return run;
  }
}

export type ProductionEmailOutboxWorkerOptions = {
  databaseUrl: string;
  smtp: SmtpEmailProviderConfig;
  pollIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  maxAttempts?: number | undefined;
  leaseMs?: number | undefined;
  databaseConnectTimeoutSeconds?: number | undefined;
  databaseStatementTimeoutMs?: number | undefined;
  onProcessed?: ((result: EmailOutboxProcessingResult) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
};

export type ProductionEmailOutboxWorkerHandle = {
  worker: EmailOutboxPollingWorker;
  sql: Sql;
  close: () => Promise<void>;
};

export function createProductionEmailOutboxWorker(
  options: ProductionEmailOutboxWorkerOptions,
): ProductionEmailOutboxWorkerHandle {
  const connectTimeoutSeconds = options.databaseConnectTimeoutSeconds ?? EMAIL_DATABASE_CONNECT_TIMEOUT_SECONDS;
  const statementTimeoutMs = options.databaseStatementTimeoutMs ?? EMAIL_DATABASE_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 30) {
    throw new Error("Email database connect timeout must be an integer between 1s and 30s");
  }
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 30_000) {
    throw new Error("Email database statement timeout must be an integer between 1000ms and 30000ms");
  }
  const sql = postgres(options.databaseUrl, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: connectTimeoutSeconds,
    connection: { statement_timeout: statementTimeoutMs },
    onnotice: () => undefined,
  });
  const store = new PostgresNotificationRepository(sql);
  const provider = createNodemailerSmtpEmailProvider(options.smtp);
  const processor = new EmailOutboxProcessor(store, provider, {
    now: () => new Date(),
    createLeaseToken: () => randomUUID(),
    maxAttempts: options.maxAttempts ?? 5,
    leaseMs: options.leaseMs ?? 60_000,
  });
  const worker = new EmailOutboxPollingWorker({
    processor,
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    batchSize: options.batchSize ?? 25,
    ...(options.onProcessed !== undefined ? { onProcessed: options.onProcessed } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  return {
    worker,
    sql,
    close: async () => {
      await worker.stop();
      await sql.end({ timeout: EMAIL_DATABASE_CLOSE_TIMEOUT_SECONDS });
    },
  };
}
