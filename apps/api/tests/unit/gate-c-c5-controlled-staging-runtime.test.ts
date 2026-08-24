import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createGateCC5ControlledStagingRuntime } from "../../scripts/gate-c-c5-controlled-staging-runtime.js";

function attestation(fields: Record<string, string>): string {
  return createHmac("sha256", "a".repeat(32))
    .update(
      Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
}

describe("Gate C C5 controlled staging runtime", () => {
  it("fails closed without every external identity, API, web, worker and operation endpoint", async () => {
    await expect(
      createGateCC5ControlledStagingRuntime({
        retainedRoot: "/tmp/gate-c-c5-retained",
        sourceSha: "a".repeat(40),
        environment: {
          GATE_C_C5_IDENTITY_BEARER_TOKEN: "x".repeat(32),
          GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET: "a".repeat(32),
          GATE_C_C5_FAULT_ATTESTATION_HMAC_SECRET: "b".repeat(32),
          GATE_C_C5_DEPLOYMENT_ID: "dpl_staging",
          GATE_C_C5_BUILD_ID: "build_staging",
        },
      }),
    ).rejects.toThrow("Gate C C5 controlled staging requires GATE_C_C5_API_PROBE_URL");
  });

  it("rejects loopback endpoints before any workload can run", async () => {
    await expect(
      createGateCC5ControlledStagingRuntime({
        retainedRoot: "/tmp/gate-c-c5-retained",
        sourceSha: "a".repeat(40),
        environment: {
          GATE_C_C5_IDENTITY_BEARER_TOKEN: "x".repeat(32),
          GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET: "a".repeat(32),
          GATE_C_C5_FAULT_ATTESTATION_HMAC_SECRET: "b".repeat(32),
          GATE_C_C5_DEPLOYMENT_ID: "dpl_staging",
          GATE_C_C5_BUILD_ID: "build_staging",
          GATE_C_C5_API_PROBE_URL: "https://localhost/health",
        },
      }),
    ).rejects.toThrow("external credential-free HTTPS URL");
  });

  it("probes all deployed components and accepts only explicit external success oracles", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const destination = new URL(url.toString());
      const headers = options?.headers as Record<string, string>;
      const value =
        options?.method === "POST"
          ? {
              outcome: "success",
              correctness: { passed: true },
              source_sha: "a".repeat(40),
              run_id: headers["x-gate-c-c5-run-id"],
              deployment_id: "dpl_staging",
              build_id: "build_staging",
              attestation: attestation({
                outcome: "success",
                source_sha: "a".repeat(40),
                run_id: headers["x-gate-c-c5-run-id"]!,
                deployment_id: "dpl_staging",
                build_id: "build_staging",
              }),
            }
          : {
              source_sha: "a".repeat(40),
              run_id: headers["x-gate-c-c5-run-id"],
              deployment_id: "dpl_staging",
              build_id: "build_staging",
              component: destination.hostname.split(".")[0],
              attestation: attestation({
                source_sha: "a".repeat(40),
                run_id: headers["x-gate-c-c5-run-id"]!,
                deployment_id: "dpl_staging",
                build_id: "build_staging",
                component: destination.hostname.split(".")[0]!,
              }),
            };
      return { ok: true, status: 200, json: async () => value } as Response;
    });
    const environment = {
      GATE_C_C5_IDENTITY_BEARER_TOKEN: "x".repeat(32),
      GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET: "a".repeat(32),
      GATE_C_C5_FAULT_ATTESTATION_HMAC_SECRET: "b".repeat(32),
      GATE_C_C5_DEPLOYMENT_ID: "dpl_staging",
      GATE_C_C5_BUILD_ID: "build_staging",
      GATE_C_C5_API_PROBE_URL: "https://api.staging.example.test/health",
      GATE_C_C5_WEB_PROBE_URL: "https://web.staging.example.test/health",
      GATE_C_C5_WORKER_PROBE_URL: "https://worker.staging.example.test/health",
      GATE_C_C5_IDENTITY_PROBE_URL: "https://identity.staging.example.test/me",
      GATE_C_C5_SCORE_EVENT_ACK_ENDPOINT: "https://api.staging.example.test/c5/score",
      GATE_C_C5_PUBLIC_CURRENT_ENDPOINT: "https://api.staging.example.test/c5/current",
      GATE_C_C5_PUBLIC_CONVERGENCE_ENDPOINT: "https://api.staging.example.test/c5/convergence",
      GATE_C_C5_LEASE_TAKEOVER_ENDPOINT: "https://api.staging.example.test/c5/lease",
      GATE_C_C5_REPAIR_PUBLICATION_ENDPOINT: "https://api.staging.example.test/c5/repair",
      GATE_C_C5_POSTGRES_IDENTIFIER: "staging-gate-c-postgres-schema",
      GATE_C_C5_REDIS_NAMESPACE: "matchday:staging:gate-c-c5:run-1:",
    };
    const runtime = await createGateCC5ControlledStagingRuntime({
      retainedRoot: "/tmp/gate-c-c5-retained",
      sourceSha: "a".repeat(40),
      environment,
      lookup: async () => [{ address: "8.8.8.8" }],
      requestJson: async (url, input) => fetchMock(url, input as never) as never,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await expect(
      runtime.executors.score_event_acknowledgement({
        operation: "score_event_acknowledgement",
        workerIndex: 0,
        sampleIndex: 0,
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    fetchMock.mockRestore();
  });
});
