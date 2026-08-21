import { describe, expect, it } from "vitest";
import {
  validateRawPhysicalPayload,
  REQUIRED_PHYSICAL_SCENARIOS,
  type RawPhysicalDevicePayload,
} from "../../scripts/import-gate-c-c3-physical-evidence.js";

describe("physical device evidence importer validator", () => {
  const validPayload: RawPhysicalDevicePayload = {
    platform: "ios",
    device_model: "Apple iPhone 15 Pro",
    os_version: "iOS 18.2",
    browser_name: "Mobile Safari",
    browser_version: "18.2",
    capture_id: "cap-phys-ios-20260821",
    collector: "MATCHDAY-QA-DEVICE-LAB",
    collection_method: "physical_device_manual",
    device_run_id: "run-phys-ios-01",
    captured_at: new Date().toISOString(),
    collected_at: new Date().toISOString(),
    trusted_https_origin: "https://staging.matchday.example.test",
    tester_attestation: "Verified on physical hardware by QA Team",
    scenarios: REQUIRED_PHYSICAL_SCENARIOS.map((scenario) => ({
      scenario,
      status: "passed",
      observed_at: new Date().toISOString(),
      assertions: ["assertion_verified"],
      observations: { test: "ok" },
      raw_trace_sha256: "a".repeat(64),
      raw_trace_events: [{ seq: 1, type: "EVENT_RECORDED", timestamp: new Date().toISOString() }],
    })),
  };

  it("accepts a valid physical device execution payload with provenance and raw trace events", () => {
    expect(() => validateRawPhysicalPayload(validPayload)).not.toThrow();
  });

  it("rejects payload missing provenance fields", () => {
    const invalid = {
      ...validPayload,
      capture_id: "",
    };
    expect(() => validateRawPhysicalPayload(invalid)).toThrow(/provenance fields/);
  });

  it("rejects payload missing raw trace events", () => {
    const invalid = {
      ...validPayload,
      scenarios: validPayload.scenarios.map((s) => ({
        ...s,
        raw_trace_events: [] as unknown[],
      })),
    };
    expect(() => validateRawPhysicalPayload(invalid)).toThrow(/requires externally captured raw trace events/);
  });

  it("rejects payload missing required scenario", () => {
    const invalid = {
      ...validPayload,
      scenarios: validPayload.scenarios.slice(0, 3),
    };
    expect(() => validateRawPhysicalPayload(invalid)).toThrow(/Missing required scenario execution/);
  });

  it("rejects non-HTTPS trusted origin", () => {
    const invalid = {
      ...validPayload,
      trusted_https_origin: "http://insecure.test",
    };
    expect(() => validateRawPhysicalPayload(invalid)).toThrow(/trusted_https_origin/);
  });

  it("rejects invalid raw trace hash length", () => {
    const invalid = {
      ...validPayload,
      scenarios: validPayload.scenarios.map((s) => ({ ...s, raw_trace_sha256: "short-hash" })),
    };
    expect(() => validateRawPhysicalPayload(invalid)).toThrow(/raw_trace_sha256/);
  });
});
