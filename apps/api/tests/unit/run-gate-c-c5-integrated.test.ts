import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertGateCC5IntegratedEvidencePathsAvailable,
  parseGateCC5IntegratedRunEnvironment,
} from "../../scripts/run-gate-c-c5-integrated.js";
import { gateCC5RetainedArtifactRoot } from "../../scripts/gate-c-c5-retained-artifacts.js";

const sourceSha = "a".repeat(40);
const receiptPath = `${gateCC5RetainedArtifactRoot(sourceSha)}/run-2/integrated-workload-receipt.json`;

afterEach(async () => {
  await rm(path.dirname(receiptPath), { recursive: true, force: true });
});

describe("Gate C C5 integrated CLI environment", () => {
  it("accepts only an explicit exact-SHA run identity and bounded operation timeout", () => {
    expect(
      parseGateCC5IntegratedRunEnvironment({
        GATE_C_C5_SOURCE_SHA: sourceSha,
        GATE_C_C5_RUN_NUMBER: "2",
        GATE_C_C5_REDIS_DATABASE: "13",
        GATE_C_C5_OPERATION_TIMEOUT_MS: "2000",
        GATE_C_C5_INTEGRATED_RECEIPT: receiptPath,
      }),
    ).toEqual({ sourceSha, runNumber: 2, redisDatabase: 13, operationTimeoutMs: 2_000, receiptPath });
  });

  it("fails closed for missing SHA, reused run labels and unsafe Redis database selection", () => {
    expect(() => parseGateCC5IntegratedRunEnvironment({})).toThrow("requires GATE_C_C5_SOURCE_SHA");
    expect(() =>
      parseGateCC5IntegratedRunEnvironment({
        GATE_C_C5_SOURCE_SHA: "a".repeat(40),
        GATE_C_C5_RUN_NUMBER: "3",
        GATE_C_C5_REDIS_DATABASE: "13",
        GATE_C_C5_INTEGRATED_RECEIPT: receiptPath,
      }),
    ).toThrow("run number must be from 1 to 2");
    expect(() =>
      parseGateCC5IntegratedRunEnvironment({
        GATE_C_C5_SOURCE_SHA: "a".repeat(40),
        GATE_C_C5_RUN_NUMBER: "1",
        GATE_C_C5_REDIS_DATABASE: "16",
        GATE_C_C5_INTEGRATED_RECEIPT: receiptPath,
      }),
    ).toThrow("Redis database must be from 0 to 15");
  });

  it("requires the deterministic receipt path inside the selected run evidence directory", () => {
    expect(() =>
      parseGateCC5IntegratedRunEnvironment({
        GATE_C_C5_SOURCE_SHA: sourceSha,
        GATE_C_C5_RUN_NUMBER: "2",
        GATE_C_C5_REDIS_DATABASE: "13",
      }),
    ).toThrow("GATE_C_C5_INTEGRATED_RECEIPT must be");
    expect(() =>
      parseGateCC5IntegratedRunEnvironment({
        GATE_C_C5_SOURCE_SHA: sourceSha,
        GATE_C_C5_RUN_NUMBER: "2",
        GATE_C_C5_REDIS_DATABASE: "13",
        GATE_C_C5_INTEGRATED_RECEIPT: `${gateCC5RetainedArtifactRoot(sourceSha)}/run-1/integrated-workload-receipt.json`,
      }),
    ).toThrow("GATE_C_C5_INTEGRATED_RECEIPT must be");
  });

  it("refuses a stale run directory before provisioning or fault injection", async () => {
    const parsed = parseGateCC5IntegratedRunEnvironment({
      GATE_C_C5_SOURCE_SHA: sourceSha,
      GATE_C_C5_RUN_NUMBER: "2",
      GATE_C_C5_REDIS_DATABASE: "13",
      GATE_C_C5_INTEGRATED_RECEIPT: receiptPath,
    });
    await expect(assertGateCC5IntegratedEvidencePathsAvailable(parsed)).resolves.toBeUndefined();
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await expect(assertGateCC5IntegratedEvidencePathsAvailable(parsed)).rejects.toThrow("pre-existing evidence path");
  });
});
