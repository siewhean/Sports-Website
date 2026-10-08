import { describe, expect, it } from "vitest";

import {
  ALERT_ROUTE_DEFINITIONS,
  SYNTHETIC_PROBE_DEFINITIONS,
  getAlertRouteDefinitions,
  getCostControlSpecification,
  getLogRetentionSpecification,
  getOperationalControl,
  getOperationalControlsInventory,
  getSyntheticProbeDefinitions,
  validateOperationalTaxonomy,
  type OpsRequirementId,
} from "./index.js";

describe("operational controls inventory and taxonomy", () => {
  it("contains all required Gate F operations requirements (OPS-004 through OPS-008, OPS-016)", () => {
    const inventory = getOperationalControlsInventory();
    const reqIds = inventory.map((item) => item.reqId);

    expect(reqIds).toEqual(["OPS-004", "OPS-005", "OPS-006", "OPS-007", "OPS-008", "OPS-016"]);
  });

  it("strictly complies with the required source and evidence taxonomies", () => {
    const inventory = getOperationalControlsInventory();

    for (const item of inventory) {
      expect(validateOperationalTaxonomy(item)).toBe(true);
      expect(["SOURCE_COMPLETE", "SOURCE_PARTIAL", "SOURCE_MISSING"]).toContain(item.sourceStatus);
      expect(["PRODUCTION_EVIDENCE_PENDING", "EXTERNAL_PROVIDER_PENDING", "VERIFIED", "NOT_REQUIRED"]).toContain(
        item.operationalStatus,
      );
    }
  });

  it("classifies OPS-004 correctly as SOURCE_COMPLETE with PRODUCTION_EVIDENCE_PENDING", () => {
    const item = getOperationalControl("OPS-004");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_COMPLETE");
    expect(item?.operationalStatus).toBe("PRODUCTION_EVIDENCE_PENDING");
    expect(item?.priority).toBe("P0");
    expect(item?.sourceComponents.length).toBeGreaterThan(0);
  });

  it("classifies OPS-005 correctly as SOURCE_COMPLETE with PRODUCTION_EVIDENCE_PENDING", () => {
    const item = getOperationalControl("OPS-005");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_COMPLETE");
    expect(item?.operationalStatus).toBe("PRODUCTION_EVIDENCE_PENDING");
    expect(item?.priority).toBe("P0");
    expect(item?.sourceComponents.length).toBeGreaterThan(0);
  });

  it("classifies OPS-006 correctly as SOURCE_MISSING with EXTERNAL_PROVIDER_PENDING", () => {
    const item = getOperationalControl("OPS-006");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_MISSING");
    expect(item?.operationalStatus).toBe("EXTERNAL_PROVIDER_PENDING");
    expect(item?.priority).toBe("P0");
    expect(item?.sourceComponents).toEqual([]);
    expect(item?.pendingPrerequisites.length).toBeGreaterThan(0);
  });

  it("classifies OPS-007 correctly as SOURCE_PARTIAL with PRODUCTION_EVIDENCE_PENDING", () => {
    const item = getOperationalControl("OPS-007");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_PARTIAL");
    expect(item?.operationalStatus).toBe("PRODUCTION_EVIDENCE_PENDING");
    expect(item?.priority).toBe("P0");
    expect(item?.sourceComponents.length).toBeGreaterThan(0);
  });

  it("classifies OPS-008 correctly as SOURCE_COMPLETE with PRODUCTION_EVIDENCE_PENDING", () => {
    const item = getOperationalControl("OPS-008");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_COMPLETE");
    expect(item?.operationalStatus).toBe("PRODUCTION_EVIDENCE_PENDING");
    expect(item?.priority).toBe("P0");
    expect(item?.sourceComponents.length).toBeGreaterThan(0);
  });

  it("classifies OPS-016 correctly as SOURCE_COMPLETE with EXTERNAL_PROVIDER_PENDING", () => {
    const item = getOperationalControl("OPS-016");
    expect(item).toBeDefined();
    expect(item?.sourceStatus).toBe("SOURCE_COMPLETE");
    expect(item?.operationalStatus).toBe("EXTERNAL_PROVIDER_PENDING");
    expect(item?.priority).toBe("P1");
    expect(item?.sourceComponents.length).toBeGreaterThan(0);
  });

  it("returns undefined for unclassified requirement IDs", () => {
    expect(getOperationalControl("OPS-999" as OpsRequirementId)).toBeUndefined();
  });
});

describe("alert route definitions and contracts", () => {
  it("defines all 4 required operational routes with targets and severity", () => {
    const routes = getAlertRouteDefinitions();
    expect(routes).toHaveLength(4);

    const conditions = routes.map((r) => r.condition);
    expect(conditions).toEqual(["service_unavailable", "scoring_latency_breach", "worker_dead", "backup_failed"]);

    const targets = routes.map((r) => r.target);
    expect(targets).toEqual(["pagerduty_or_webhook", "oncall_slack", "infra_alerts", "ops_alerts"]);
  });

  it("assigns appropriate severity and thresholds to each condition", () => {
    const routes = ALERT_ROUTE_DEFINITIONS;
    const serviceRoute = routes.find((r) => r.condition === "service_unavailable");
    const scoringRoute = routes.find((r) => r.condition === "scoring_latency_breach");
    const workerRoute = routes.find((r) => r.condition === "worker_dead");
    const backupRoute = routes.find((r) => r.condition === "backup_failed");

    expect(serviceRoute?.severity).toBe("S1_CRITICAL");
    expect(scoringRoute?.severity).toBe("S2_HIGH");
    expect(workerRoute?.severity).toBe("S1_CRITICAL");
    expect(backupRoute?.severity).toBe("S2_HIGH");

    expect(scoringRoute?.threshold).toContain("500");
  });
});

describe("synthetic probe definitions and SLO thresholds", () => {
  it("defines the 4 required synthetic probe targets with intervals and status codes", () => {
    const probes = getSyntheticProbeDefinitions();
    expect(probes).toHaveLength(4);

    const names = probes.map((p) => p.name);
    expect(names).toEqual(["homepage", "health_ready", "meta_build", "public_competition_read"]);

    for (const probe of probes) {
      expect(probe.expectedStatusCode).toBe(200);
      expect(probe.timeoutMs).toBeGreaterThan(0);
      expect([30, 60]).toContain(probe.intervalSec);
      expect(probe.path.startsWith("/")).toBe(true);
    }
  });

  it("enforces health_ready probe runs at 30-second interval", () => {
    const healthProbe = SYNTHETIC_PROBE_DEFINITIONS.find((p) => p.name === "health_ready");
    expect(healthProbe?.intervalSec).toBe(30);
    expect(healthProbe?.timeoutMs).toBe(3000);
  });
});

describe("structured log retention specification (OPS-007)", () => {
  it("specifies 90-day retention and NDJSON log engine with ISO timestamps", () => {
    const spec = getLogRetentionSpecification();
    expect(spec.logEngine).toBe("pino");
    expect(spec.format).toBe("ndjson");
    expect(spec.targetRetentionDays).toBe(90);
    expect(spec.piiScrubbingStatus).toBe("SOURCE_COMPLETE");
    expect(spec.hostAggregatorStatus).toBe("SOURCE_PARTIAL");
    expect(spec.policyReference).toBe("docs/policies/PUBLIC_DATA.md");
    expect(spec.contextFields).toContain("requestId");
    expect(spec.contextFields).toContain("correlationId");
    expect(spec.contextFields).toContain("jobId");
  });
});

describe("cost control specification (OPS-016)", () => {
  it("covers all 5 mandatory cost categories across OCI and email infrastructure", () => {
    const spec = getCostControlSpecification();
    expect(spec.anomalyDetectionRequired).toBe(true);
    expect(spec.budgetAlertsRequired).toBe(true);

    const categories = spec.categories.map((c) => c.category);
    expect(categories).toEqual([
      "compute_a1_flex",
      "block_storage",
      "object_storage",
      "network_egress",
      "transactional_email",
    ]);

    const ociCategories = spec.categories.filter((c) => c.provider === "OCI");
    expect(ociCategories).toHaveLength(4);

    const emailCategory = spec.categories.find((c) => c.provider === "Resend");
    expect(emailCategory).toBeDefined();
    expect(emailCategory?.category).toBe("transactional_email");
  });
});
