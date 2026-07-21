export interface NotificationRateLimiter {
  assertAllowed(accountId: string, notificationType: string, now: Date): Promise<void>;
}

export class NotificationRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Notification rate limit exceeded; retry after ${retryAfterMs}ms`);
    this.name = "NotificationRateLimitError";
  }
}

export type InMemoryNotificationRateLimiterOptions = {
  maximum: number;
  windowMs: number;
};

export class InMemoryNotificationRateLimiter implements NotificationRateLimiter {
  readonly #timestamps = new Map<string, number[]>();

  constructor(private readonly options: InMemoryNotificationRateLimiterOptions) {
    if (!Number.isInteger(options.maximum) || options.maximum < 1) {
      throw new Error("Notification rate limit maximum must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("Notification rate limit window must be a positive integer");
    }
  }

  async assertAllowed(accountId: string, notificationType: string, now: Date): Promise<void> {
    const key = `${accountId}:${notificationType}`;
    const threshold = now.getTime() - this.options.windowMs;
    const recent = (this.#timestamps.get(key) ?? []).filter((timestamp) => timestamp > threshold);

    if (recent.length >= this.options.maximum) {
      const oldest = recent[0];
      if (oldest === undefined) throw new Error("Notification rate limit state is invalid");
      throw new NotificationRateLimitError(oldest + this.options.windowMs - now.getTime());
    }

    recent.push(now.getTime());
    this.#timestamps.set(key, recent);
  }
}

export class NoopNotificationRateLimiter implements NotificationRateLimiter {
  async assertAllowed(): Promise<void> {}
}
