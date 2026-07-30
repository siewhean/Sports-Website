import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gateCC5OperationKinds } from "./gate-c-c5-workload-profiles.mjs";
import {
  percentile,
  runGateCC5Load,
  seededRandom,
  validateTargetManifest,
} from "./run-gate-c-c5-load.mjs";

function targets(overrides = {}) {
  return {
    schemaVersion: 1,
    operations: Object.fromEntries(
      gateCC5OperationKinds.map((operation) => [
        operation,
        {
          method: operation.includes("read") ? "GET" : "POST",
          path: `/c5/${operation}/{request_id}`,
          body: { operation, match_id: "{match_id}" },
          expectedStatuses: [204],
          ...(overrides[operation] ?? {}),
        },
      ]),
    ),
  };
}

test("seeded random generation is reproducible", () => {
  const left = seededRandom("same-seed");
  const right = seededRandom("same-seed");
  assert.deepEqual(Array.from({ length: 10 }, () => left()), Array.from({ length: 10 }, () => right()));
});

test("percentiles use a deterministic nearest-rank calculation", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.throws(() => percentile([1], 1.1), /\[0,1\]/);
});

test("target manifests reject credential-bearing and unsafe requests", () => {
  assert.throws(
    () =>
      validateTargetManifest(
        targets({ score_event_write: { headers: { Authorization: "Bearer hidden" } } }),
        gateCC5OperationKinds,
      ),
    /Credential-bearing headers/,
  );
  assert.throws(
    () =>
      validateTargetManifest(
        targets({ score_event_write: { path: "/score#access=hidden" } }),
        gateCC5OperationKinds,
      ),
    /Unsafe target path/,
  );
});

test("a bounded local run emits an exact receipt with no failures", async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.statusCode = 204;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

  try {
    const receipt = await runGateCC5Load({
      baseUrl: `http://127.0.0.1:${address.port}`,
      profileId: "small",
      mode: "constant-arrival",
      durationSeconds: 0.25,
      maximumConcurrency: 8,
      timeoutMs: 1_000,
      seed: "local-test",
      sourceSha: "a".repeat(40),
      targetManifest: targets(),
    });

    assert.equal(receipt.artifactKind, "gate-c-c5-load-receipt");
    assert.equal(receipt.sourceSha, "a".repeat(40));
    assert.ok(receipt.summary.requestCount > 0);
    assert.equal(receipt.summary.failureCount, 0);
    assert.match(receipt.baseOriginSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
