/**
 * operational-controls.ts
 *
 * Formal inventory, taxonomy classifications, and operational specifications
 * for MATCHDAY Gate F operational requirements:
 * - OPS-004: Monitoring Dashboards (API latency, error rates, queue depth, scoring sessions, public reads)
 * - OPS-005: Alerting Rules (service unavailable, latency breach, dead worker, backup failed)
 * - OPS-006: External Status Page (public platform status visible to organisers)
 * - OPS-007: Log Aggregation & Retention (structured JSON logs with PII scrubbing, 90-day retention)
 * - OPS-008: Synthetic Health Monitoring (external probes checking health endpoints every minute)
 * - OPS-016: Cost Monitoring & Controls (infrastructure cost tracking with alerts on unexpected increases)
 *
 * Taxonomies strictly follow Gate F requirements:
 * - SourceStatus: SOURCE_COMPLETE | SOURCE_PARTIAL | SOURCE_MISSING
 * - OperationalEvidenceStatus: PRODUCTION_EVIDENCE_PENDING | EXTERNAL_PROVIDER_PENDING | VERIFIED | NOT_REQUIRED
 */

export type SourceStatus = "SOURCE_COMPLETE" | "SOURCE_PARTIAL" | "SOURCE_MISSING";

export type OperationalEvidenceStatus =
  "PRODUCTION_EVIDENCE_PENDING" | "EXTERNAL_PROVIDER_PENDING" | "VERIFIED" | "NOT_REQUIRED";

export type OpsRequirementId = "OPS-004" | "OPS-005" | "OPS-006" | "OPS-007" | "OPS-008" | "OPS-016";

export interface OperationalItemClassification {
  readonly reqId: OpsRequirementId;
  readonly name: string;
  readonly sourceStatus: SourceStatus;
  readonly operationalStatus: OperationalEvidenceStatus;
  readonly priority: "P0" | "P1";
  readonly description: string;
  readonly sourceComponents: readonly string[];
  readonly pendingPrerequisites: readonly string[];
}

export interface AlertRouteDefinition {
  readonly condition: string;
  readonly target: string;
  readonly severity: "S1_CRITICAL" | "S2_HIGH" | "S3_MEDIUM";
  readonly description: string;
  readonly threshold: string;
}

export interface SyntheticProbeDefinition {
  readonly name: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly intervalSec: number;
  readonly timeoutMs: number;
  readonly expectedStatusCode: number;
  readonly targetSlo: string;
}

export interface LogRetentionSpecification {
  readonly logEngine: string;
  readonly format: string;
  readonly timestampFormat: string;
  readonly contextFields: readonly string[];
  readonly piiScrubbingStatus: SourceStatus;
  readonly targetRetentionDays: number;
  readonly policyReference: string;
  readonly hostAggregatorStatus: SourceStatus;
}

export interface CostControlCategoryDefinition {
  readonly category: string;
  readonly description: string;
  readonly provider: "OCI" | "Resend";
  readonly alertMechanism: string;
}

export interface CostControlSpecification {
  readonly categories: readonly CostControlCategoryDefinition[];
  readonly anomalyDetectionRequired: boolean;
  readonly budgetAlertsRequired: boolean;
  readonly billingAccountCurrency: "SGD" | "USD";
}

/**
 * Authoritative classification matrix for Gate F operational controls.
 */
export const OPERATIONAL_CONTROLS_INVENTORY: readonly OperationalItemClassification[] = [
  {
    reqId: "OPS-004",
    name: "Monitoring Dashboards",
    sourceStatus: "SOURCE_COMPLETE",
    operationalStatus: "PRODUCTION_EVIDENCE_PENDING",
    priority: "P0",
    description:
      "Monitoring dashboards for API latency, error rates, worker queue depth, active scoring sessions, and public reads.",
    sourceComponents: [
      "packages/observability/src/metrics.ts (OpenTelemetry provider-neutral metrics)",
      "packages/observability/src/tracing.ts (Distributed tracing & spans)",
      "packages/observability/src/runtime.ts (OTLP exporter runtime manager)",
      "packages/observability/src/pilot-telemetry.ts (Pilot telemetry collector)",
      "infra/oci/otel-collector.yaml (OpenTelemetry collector pipeline)",
      "scripts/run-gate-f-ops-audit.mjs (SLO baseline probe validator)",
    ],
    pendingPrerequisites: [
      "Live production metric emission and OCI Monitoring dashboard configuration",
      "Production metric capture receipt conforming to validate-external-evidence.mjs",
    ],
  },
  {
    reqId: "OPS-005",
    name: "Alerting Rules",
    sourceStatus: "SOURCE_COMPLETE",
    operationalStatus: "PRODUCTION_EVIDENCE_PENDING",
    priority: "P0",
    description:
      "Alerting rules across critical operational conditions: service unavailable, latency breach, worker dead, and backup failure.",
    sourceComponents: [
      "packages/observability/src/error-reporter.ts (Sanitized exception capture & propagation)",
      "scripts/run-gate-f-ops-audit.mjs (Configured alert routes & drill verification)",
    ],
    pendingPrerequisites: [
      "Live alert delivery drill across all 4 configured notification routes",
      "Delivery acknowledgement provider receipt conforming to validate-external-evidence.mjs",
    ],
  },
  {
    reqId: "OPS-006",
    name: "External Status Page",
    sourceStatus: "SOURCE_MISSING",
    operationalStatus: "EXTERNAL_PROVIDER_PENDING",
    priority: "P0",
    description:
      "Public platform status page visible to competition organisers, independent of the primary hosting infrastructure.",
    sourceComponents: [],
    pendingPrerequisites: [
      "External status page provider (e.g. Instatus / BetterUptime / Statuspage) provisioning",
      "DNS configuration and automated component health sync",
      "Public incident communication runbook integration",
    ],
  },
  {
    reqId: "OPS-007",
    name: "Log Aggregation & Retention",
    sourceStatus: "SOURCE_PARTIAL",
    operationalStatus: "PRODUCTION_EVIDENCE_PENDING",
    priority: "P0",
    description: "Structured JSON logs with PII scrubbing, 90-day log retention for security auditability.",
    sourceComponents: [
      "packages/observability/src/logger.ts (Pino structured NDJSON logging with ISO timestamps)",
      "packages/observability/src/sanitize.ts (Deep recursive PII and credential redaction)",
      "docs/policies/PUBLIC_DATA.md (Policy declaring 90-day retention requirement)",
    ],
    pendingPrerequisites: [
      "Host-level log shipper daemon (e.g. vector / fluent-bit / OCI Logging agent) configuration",
      "90-day retention lifecycle policy verification receipt on production object storage",
    ],
  },
  {
    reqId: "OPS-008",
    name: "Synthetic Health Monitoring",
    sourceStatus: "SOURCE_COMPLETE",
    operationalStatus: "PRODUCTION_EVIDENCE_PENDING",
    priority: "P0",
    description:
      "External synthetic probes checking health endpoints and public pages at 30s/60s intervals with SLO threshold enforcement.",
    sourceComponents: [
      "packages/observability/src/c5-integrated-workload.ts (Synthetic workload harness)",
      "packages/observability/src/pilot-telemetry.ts (SLO budget enforcement)",
      "scripts/run-gate-f-ops-audit.mjs (4 protocol probe targets and SLO thresholds)",
      "apps/api health endpoints (/, /health/ready, /api/v1/meta/build, /api/v1/competitions/:id)",
    ],
    pendingPrerequisites: [
      "External synthetic monitoring service probe configuration",
      "Live synthetic probe execution receipt conforming to validate-external-evidence.mjs",
    ],
  },
  {
    reqId: "OPS-016",
    name: "Cost Monitoring & Controls",
    sourceStatus: "SOURCE_COMPLETE",
    operationalStatus: "EXTERNAL_PROVIDER_PENDING",
    priority: "P1",
    description:
      "Infrastructure cost tracking across 5 core categories with automated budget alerts on unexpected increases.",
    sourceComponents: [
      "scripts/run-gate-f-ops-audit.mjs (Cost category verification: compute_a1_flex, block_storage, object_storage, network_egress, transactional_email)",
    ],
    pendingPrerequisites: [
      "Cloud provider billing account budget alert setup",
      "Provider billing anomaly detection receipt conforming to validate-external-evidence.mjs",
    ],
  },
] as const;

/**
 * Standard alerting routes and threshold contracts.
 */
export const ALERT_ROUTE_DEFINITIONS: readonly AlertRouteDefinition[] = [
  {
    condition: "service_unavailable",
    target: "pagerduty_or_webhook",
    severity: "S1_CRITICAL",
    description: "API HTTP 5xx error rate > 5% over 1 min or unready health probe",
    threshold: "error_rate > 0.05 over 1m OR /health/ready status != 200",
  },
  {
    condition: "scoring_latency_breach",
    target: "oncall_slack",
    severity: "S2_HIGH",
    description: "Live score event acknowledgement p95 latency exceeds 500ms over 2 mins",
    threshold: "scoring_p95_ms > 500 over 2m",
  },
  {
    condition: "worker_dead",
    target: "infra_alerts",
    severity: "S1_CRITICAL",
    description: "Background worker process crash, unhandled exit, or heartbeats missing",
    threshold: "worker_heartbeat_missed > 30s OR unhandled_exit",
  },
  {
    condition: "backup_failed",
    target: "ops_alerts",
    severity: "S2_HIGH",
    description: "Daily scheduled database backup failure or WAL archive pipeline error",
    threshold: "backup_exit_code != 0 OR wal_archive_lag > 30m",
  },
] as const;

/**
 * Standard synthetic probe target specifications.
 */
export const SYNTHETIC_PROBE_DEFINITIONS: readonly SyntheticProbeDefinition[] = [
  {
    name: "homepage",
    path: "/",
    method: "GET",
    intervalSec: 60,
    timeoutMs: 5000,
    expectedStatusCode: 200,
    targetSlo: "availability >= 99.9%, public_read_p95 <= 2500ms",
  },
  {
    name: "health_ready",
    path: "/health/ready",
    method: "GET",
    intervalSec: 30,
    timeoutMs: 3000,
    expectedStatusCode: 200,
    targetSlo: "availability >= 99.99%, latency_p95 <= 500ms",
  },
  {
    name: "meta_build",
    path: "/api/v1/meta/build",
    method: "GET",
    intervalSec: 60,
    timeoutMs: 5000,
    expectedStatusCode: 200,
    targetSlo: "availability >= 99.9%, latency_p95 <= 1000ms",
  },
  {
    name: "public_competition_read",
    path: "/api/v1/competitions/:id",
    method: "GET",
    intervalSec: 60,
    timeoutMs: 5000,
    expectedStatusCode: 200,
    targetSlo: "availability >= 99.9%, public_read_p95 <= 2500ms",
  },
] as const;

/**
 * Structured log retention specification (OPS-007).
 */
export const LOG_RETENTION_SPECIFICATION: LogRetentionSpecification = {
  logEngine: "pino",
  format: "ndjson",
  timestampFormat: "iso8601_utc",
  contextFields: ["requestId", "correlationId", "jobId", "traceId", "spanId"],
  piiScrubbingStatus: "SOURCE_COMPLETE",
  targetRetentionDays: 90,
  policyReference: "docs/policies/PUBLIC_DATA.md",
  hostAggregatorStatus: "SOURCE_PARTIAL",
};

/**
 * Monitored cost categories and specification (OPS-016).
 */
export const COST_CONTROL_SPECIFICATION: CostControlSpecification = {
  categories: [
    {
      category: "compute_a1_flex",
      description: "OCI Ampere A1 Flex 4-core OCPU / 24GB RAM host instance",
      provider: "OCI",
      alertMechanism: "OCI Budget Alert on forecasted monthly threshold breach",
    },
    {
      category: "block_storage",
      description: "Boot and PostgreSQL database block storage volumes",
      provider: "OCI",
      alertMechanism: "OCI Cost Anomaly Detection on capacity growth spikes",
    },
    {
      category: "object_storage",
      description: "Off-host encrypted backup buckets and lifecycle retention tiers",
      provider: "OCI",
      alertMechanism: "OCI Budget Alert on storage volume growth",
    },
    {
      category: "network_egress",
      description: "Public edge and staging outbound network traffic",
      provider: "OCI",
      alertMechanism: "OCI Network Egress monitoring and quota alert",
    },
    {
      category: "transactional_email",
      description: "Resend transactional organizer & participant dispatch email quota",
      provider: "Resend",
      alertMechanism: "Resend daily sending quota notification webhook",
    },
  ],
  anomalyDetectionRequired: true,
  budgetAlertsRequired: true,
  billingAccountCurrency: "USD",
};

/**
 * Returns all classified operational controls for Gate F.
 */
export function getOperationalControlsInventory(): readonly OperationalItemClassification[] {
  return OPERATIONAL_CONTROLS_INVENTORY;
}

/**
 * Retrieves a specific operational control by its requirement ID.
 */
export function getOperationalControl(reqId: OpsRequirementId): OperationalItemClassification | undefined {
  return OPERATIONAL_CONTROLS_INVENTORY.find((item) => item.reqId === reqId);
}

/**
 * Validates that an operational item complies with the required taxonomy.
 */
export function validateOperationalTaxonomy(item: OperationalItemClassification): boolean {
  const validSourceStatuses: readonly SourceStatus[] = ["SOURCE_COMPLETE", "SOURCE_PARTIAL", "SOURCE_MISSING"];
  const validEvidenceStatuses: readonly OperationalEvidenceStatus[] = [
    "PRODUCTION_EVIDENCE_PENDING",
    "EXTERNAL_PROVIDER_PENDING",
    "VERIFIED",
    "NOT_REQUIRED",
  ];

  return (
    validSourceStatuses.includes(item.sourceStatus) &&
    validEvidenceStatuses.includes(item.operationalStatus) &&
    item.name.length > 0 &&
    item.description.length > 0 &&
    (item.sourceStatus === "SOURCE_MISSING" || item.sourceComponents.length > 0)
  );
}

/**
 * Returns the alert routing definitions.
 */
export function getAlertRouteDefinitions(): readonly AlertRouteDefinition[] {
  return ALERT_ROUTE_DEFINITIONS;
}

/**
 * Returns the synthetic probe definitions.
 */
export function getSyntheticProbeDefinitions(): readonly SyntheticProbeDefinition[] {
  return SYNTHETIC_PROBE_DEFINITIONS;
}

/**
 * Returns the log retention specification.
 */
export function getLogRetentionSpecification(): LogRetentionSpecification {
  return LOG_RETENTION_SPECIFICATION;
}

/**
 * Returns the cost control specification.
 */
export function getCostControlSpecification(): CostControlSpecification {
  return COST_CONTROL_SPECIFICATION;
}
