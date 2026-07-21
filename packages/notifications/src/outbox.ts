import {
  classifyEmailDeliveryError,
  EmailRecipientRejectedError,
  type DeliveryFailureClassification,
  type EmailProvider,
} from "./email.js";
import type { EmailMessage } from "./types.js";

export type EmailOutboxStatus = "pending" | "processing" | "delivered" | "dead_letter";

export type EmailOutboxItem = {
  id: string;
  message: EmailMessage;
  status: EmailOutboxStatus;
  attempts: number;
  createdAt: string;
  availableAt: string;
  lockedUntil: string | null;
  leaseToken: string | null;
  deliveredAt: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  lastFailureClassification: DeliveryFailureClassification | null;
};

export interface EmailOutboxStore {
  enqueue(item: EmailOutboxItem): Promise<EmailOutboxItem>;
  findByIdempotencyKey(idempotencyKey: string): Promise<EmailOutboxItem | null>;
  claimDue(now: string, limit: number, lockedUntil: string, leaseToken: string): Promise<readonly EmailOutboxItem[]>;
  markDelivered(
    id: string,
    leaseToken: string,
    deliveredAt: string,
    providerMessageId: string,
  ): Promise<EmailOutboxItem>;
  markFailed(
    id: string,
    leaseToken: string,
    classification: DeliveryFailureClassification,
    message: string,
    availableAt: string | null,
  ): Promise<EmailOutboxItem>;
}

function cloneItem(item: EmailOutboxItem): EmailOutboxItem {
  return { ...item, message: { ...item.message, template: { ...item.message.template } } };
}

export class InMemoryEmailOutboxStore implements EmailOutboxStore {
  readonly #items = new Map<string, EmailOutboxItem>();
  readonly #idempotencyIndex = new Map<string, string>();

  async enqueue(item: EmailOutboxItem): Promise<EmailOutboxItem> {
    const existingId = this.#idempotencyIndex.get(item.message.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.#items.get(existingId);
      if (existing !== undefined) return cloneItem(existing);
    }
    this.#items.set(item.id, cloneItem(item));
    this.#idempotencyIndex.set(item.message.idempotencyKey, item.id);
    return cloneItem(item);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<EmailOutboxItem | null> {
    const id = this.#idempotencyIndex.get(idempotencyKey);
    const item = id === undefined ? undefined : this.#items.get(id);
    return item === undefined ? null : cloneItem(item);
  }

  async claimDue(
    now: string,
    limit: number,
    lockedUntil: string,
    leaseToken: string,
  ): Promise<readonly EmailOutboxItem[]> {
    const candidates = [...this.#items.values()]
      .filter(
        (item) =>
          (item.status === "pending" ||
            (item.status === "processing" && item.lockedUntil !== null && item.lockedUntil <= now)) &&
          item.availableAt <= now,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(0, limit));

    return candidates.map((candidate) => {
      const claimed: EmailOutboxItem = {
        ...candidate,
        status: "processing",
        lockedUntil,
        leaseToken,
      };
      this.#items.set(claimed.id, claimed);
      return cloneItem(claimed);
    });
  }

  async markDelivered(
    id: string,
    leaseToken: string,
    deliveredAt: string,
    providerMessageId: string,
  ): Promise<EmailOutboxItem> {
    const item = this.#require(id);
    this.#assertLease(item, leaseToken);
    const updated: EmailOutboxItem = {
      ...item,
      status: "delivered",
      attempts: item.attempts + 1,
      lockedUntil: null,
      leaseToken: null,
      deliveredAt,
      providerMessageId,
      lastError: null,
      lastFailureClassification: null,
    };
    this.#items.set(id, updated);
    return cloneItem(updated);
  }

  async markFailed(
    id: string,
    leaseToken: string,
    classification: DeliveryFailureClassification,
    message: string,
    availableAt: string | null,
  ): Promise<EmailOutboxItem> {
    const item = this.#require(id);
    this.#assertLease(item, leaseToken);
    const updated: EmailOutboxItem = {
      ...item,
      status: availableAt === null ? "dead_letter" : "pending",
      attempts: item.attempts + 1,
      availableAt: availableAt ?? item.availableAt,
      lockedUntil: null,
      leaseToken: null,
      lastError: message,
      lastFailureClassification: classification,
    };
    this.#items.set(id, updated);
    return cloneItem(updated);
  }

  #require(id: string): EmailOutboxItem {
    const item = this.#items.get(id);
    if (item === undefined) throw new Error(`Email outbox item ${id} does not exist`);
    return item;
  }

  #assertLease(item: EmailOutboxItem, leaseToken: string): void {
    if (item.status !== "processing" || item.leaseToken !== leaseToken) {
      throw new StaleEmailOutboxLeaseError(item.id);
    }
  }
}

export class StaleEmailOutboxLeaseError extends Error {
  constructor(id: string) {
    super(`Email outbox item ${id} is no longer owned by this lease`);
    this.name = "StaleEmailOutboxLeaseError";
  }
}

export type EmailOutboxServiceOptions = {
  createId: () => string;
  now: () => Date;
};

export function createEmailOutboxItem(input: { id: string; message: EmailMessage; now: string }): EmailOutboxItem {
  return {
    id: input.id,
    message: input.message,
    status: "pending",
    attempts: 0,
    createdAt: input.now,
    availableAt: input.now,
    lockedUntil: null,
    leaseToken: null,
    deliveredAt: null,
    providerMessageId: null,
    lastError: null,
    lastFailureClassification: null,
  };
}

export class EmailOutboxService {
  constructor(
    private readonly store: EmailOutboxStore,
    private readonly options: EmailOutboxServiceOptions,
  ) {}

  async enqueue(message: EmailMessage): Promise<EmailOutboxItem> {
    const existing = await this.store.findByIdempotencyKey(message.idempotencyKey);
    if (existing !== null) return existing;

    const now = this.options.now().toISOString();
    return this.store.enqueue(createEmailOutboxItem({ id: this.options.createId(), message, now }));
  }
}

export function calculateRetryDelayMs(
  completedAttempts: number,
  baseDelayMs = 30_000,
  maximumDelayMs = 3_600_000,
): number {
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** Math.max(0, completedAttempts - 1));
}

export type EmailOutboxProcessorOptions = {
  now: () => Date;
  createLeaseToken: () => string;
  maxAttempts?: number;
  leaseMs?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
};

export type EmailOutboxProcessingResult = {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
};

export class EmailOutboxProcessor {
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  readonly #baseDelayMs: number;
  readonly #maximumDelayMs: number;

  constructor(
    private readonly store: EmailOutboxStore,
    private readonly provider: EmailProvider,
    private readonly options: EmailOutboxProcessorOptions,
  ) {
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#baseDelayMs = options.baseDelayMs ?? 30_000;
    this.#maximumDelayMs = options.maximumDelayMs ?? 3_600_000;
  }

  async processDue(limit = 25): Promise<EmailOutboxProcessingResult> {
    const now = this.options.now();
    const leaseToken = this.options.createLeaseToken();
    const claimed = await this.store.claimDue(
      now.toISOString(),
      limit,
      new Date(now.getTime() + this.#leaseMs).toISOString(),
      leaseToken,
    );
    const result = { claimed: claimed.length, delivered: 0, retried: 0, deadLettered: 0 };

    for (const item of claimed) {
      try {
        const receipt = await this.provider.send(item.message);
        if (receipt.accepted.length === 0) throw new EmailRecipientRejectedError();
        await this.store.markDelivered(
          item.id,
          leaseToken,
          this.options.now().toISOString(),
          receipt.providerMessageId,
        );
        result.delivered += 1;
      } catch (error) {
        const classification = classifyEmailDeliveryError(error);
        const completedAttempts = item.attempts + 1;
        const exhausted = completedAttempts >= this.#maxAttempts;
        const shouldRetry = classification === "transient" && !exhausted;
        const failureMessage = error instanceof Error ? error.message : "Unknown email delivery error";
        const availableAt = shouldRetry
          ? new Date(
              this.options.now().getTime() +
                calculateRetryDelayMs(completedAttempts, this.#baseDelayMs, this.#maximumDelayMs),
            ).toISOString()
          : null;
        await this.store.markFailed(item.id, leaseToken, classification, failureMessage, availableAt);
        if (shouldRetry) result.retried += 1;
        else result.deadLettered += 1;
      }
    }

    return result;
  }
}
