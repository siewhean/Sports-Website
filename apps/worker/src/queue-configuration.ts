const queuePrefixPattern = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/u;

/**
 * Returns the optional BullMQ prefix reserved for an isolated local run.
 *
 * The override is available only to the C5 local test harness. Production
 * workers and producers retain BullMQ's shared default configuration, so a
 * stray environment variable cannot strand jobs in an unread queue.
 */
export function resolveWorkerQueuePrefix(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.MATCHDAY_WORKER_QUEUE_PREFIX?.trim();
  if (!configured) return undefined;
  if (environment.APP_ENV !== "test") {
    throw new Error("MATCHDAY_WORKER_QUEUE_PREFIX is permitted only for isolated APP_ENV=test runs");
  }
  if (!queuePrefixPattern.test(configured)) {
    throw new Error("MATCHDAY_WORKER_QUEUE_PREFIX must be 3-64 lowercase letters, digits, or hyphens");
  }
  return configured;
}
