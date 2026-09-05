/**
 * Shared QA-011 controlled-staging contract.
 *
 * These values are deliberately owned by the API workspace: both the staging
 * seeder and the network runner must agree before any secret handoff occurs.
 */

/** Number of independent finalisable matches required for propagation p95. */
export const GATE_D_PROPAGATION_SAMPLE_COUNT = 10;

/** Keep the production 45-second writer lease alive without changing it. */
export const GATE_D_WRITER_HEARTBEAT_INTERVAL_MS = 15_000;
