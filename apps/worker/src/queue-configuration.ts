const queuePrefixPattern = /^[a-z](?:[a-z0-9-]{1,62}[a-z0-9])?$/u;

/**
 * Returns the optional BullMQ prefix reserved for an isolated local run.
 *
 * Production intentionally keeps BullMQ's default prefix unless an operator
 * supplies this explicit, constrained override. Prefixes never include
 * credentials or Redis URLs, and cannot contain a colon that would blur the
 * ownership boundary used by the local harness.
 */
export function resolveWorkerQueuePrefix(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.MATCHDAY_WORKER_QUEUE_PREFIX?.trim();
  if (!configured) return undefined;
  if (!queuePrefixPattern.test(configured)) {
    throw new Error("MATCHDAY_WORKER_QUEUE_PREFIX must be 3-64 lowercase letters, digits, or hyphens");
  }
  return configured;
}
