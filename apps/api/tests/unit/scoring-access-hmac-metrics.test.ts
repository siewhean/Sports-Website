import type { Meter } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PostgresJsSql } from "@matchday/identity";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { createScoringAccessHmacMetrics } from "../../src/scoring-access-hmac-metrics.js";
import { reconcileScoringAccessHmacKeyring } from "../../src/scoring-access-hmac-keyring.js";
import { RedisScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";
import { startApiTelemetry } from "../../src/telemetry.js";
import { testConfig } from "../helpers.js";

const keyring = {
  primary: { version: "v2", secret: "synthetic-key-material-at-least-32-bytes" },
  verificationOnly: [],
};
const credential = "synthetic-scoring-credential";
const ip = "198.51.100.12";

function fakeRedis(): Redis {
  const multi = {
    ttl() {
      return this;
    },
    get() {
      return this;
    },
    async exec() {
      return [
        [null, -1],
        [null, -1],
        [null, null],
        [null, -1],
        [null, null],
        [null, -1],
      ];
    },
  };
  return { multi: () => multi, eval: async () => [1, 1, 600, 600, 0, 0, 0], del: async () => 2 } as unknown as Redis;
}

function emptyRegistry(): PostgresJsSql {
  const sql = {
    unsafe: vi.fn(async () => []),
    begin: async <T>(operation: (tx: PostgresJsSql) => Promise<T>) => operation(sql as unknown as PostgresJsSql),
  };
  return sql as unknown as PostgresJsSql;
}

function exported(exporter: InMemoryMetricExporter) {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
}

async function startEnabled(exporter: InMemoryMetricExporter) {
  return startApiTelemetry(testConfig({ OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }), {
    metricExporter: exporter,
    traceExporter: new InMemorySpanExporter(),
    metricExportIntervalMs: 60000,
  });
}

async function exercise(recorder: Awaited<ReturnType<typeof startApiTelemetry>>["scoringAccessHmacMetrics"]) {
  const limiter = new RedisScoringAccessRateLimiter(fakeRedis(), keyring, "synthetic:", undefined, recorder);
  expect(await limiter.assertAllowed(credential, ip)).toEqual({ limit: 5, remaining: 5, resetSeconds: 0 });
  expect(await limiter.recordInvalid(credential, ip)).toEqual({ limit: 5, remaining: 4, resetSeconds: 600 });
  await expect(limiter.recordSuccess(credential, ip)).resolves.toBeUndefined();
  const sql = emptyRegistry();
  await reconcileScoringAccessHmacKeyring(sql, keyring, undefined, recorder);
  expect(sql.unsafe).toHaveBeenCalled();
}

describe("runtime-bound scoring HMAC metrics", () => {
  it("exports both counters from actual rate-limit and committed lifecycle calls with only public labels", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = await startEnabled(exporter);
    try {
      await exercise(telemetry.scoringAccessHmacMetrics);
    } finally {
      await telemetry.shutdown();
    }
    const data = exported(exporter);
    const rateLimit = data.find(
      (metric) => metric.descriptor.name === "scoring_access_hmac_rate_limit_operations_total",
    );
    expect(rateLimit?.dataPoints).toHaveLength(3);
    expect(rateLimit?.dataPoints.map((point) => point.attributes)).toEqual(
      expect.arrayContaining(
        ["assert", "invalid", "success"].map((operation) => ({
          "scoring_access.hmac.primary_version": "v2",
          "scoring_access.hmac.accepted_version_count": 1,
          "scoring_access.hmac.operation": operation,
        })),
      ),
    );
    const lifecycle = data.find((metric) => metric.descriptor.name === "scoring_access_hmac_key_lifecycle_total");
    expect(lifecycle?.dataPoints).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: {
          "scoring_access.hmac.key_version": "v2",
          "scoring_access.hmac.lifecycle_action": "activated",
        },
      }),
    ]);
    for (const sensitive of [keyring.primary.secret, credential, ip])
      expect(JSON.stringify(data)).not.toContain(sensitive);
  });

  it("keeps disabled scoring work normal without recording into another active runtime", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const enabled = await startEnabled(exporter);
    const disabled = await startApiTelemetry(testConfig());
    try {
      await exercise(disabled.scoringAccessHmacMetrics);
    } finally {
      await disabled.shutdown();
      await enabled.shutdown();
    }
    expect(exported(exporter)).toEqual([]);
  });

  it("keeps concurrent API providers isolated", async () => {
    const exporters = [
      new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    ];
    const [first, second] = await Promise.all(exporters.map(startEnabled));
    try {
      await exercise(first!.scoringAccessHmacMetrics);
    } finally {
      await Promise.all([first!.shutdown(), second!.shutdown()]);
    }
    expect(
      exported(exporters[0]!).some((metric) => metric.descriptor.name === "scoring_access_hmac_key_lifecycle_total"),
    ).toBe(true);
    expect(exported(exporters[1]!)).toEqual([]);
  });

  it("does not fail scoring work when the exporter fails", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const failure = vi
      .spyOn(exporter, "export")
      .mockImplementation((_data, done) => done({ code: 1, error: new Error("synthetic exporter outage") }));
    const telemetry = await startEnabled(exporter);
    try {
      await exercise(telemetry.scoringAccessHmacMetrics);
    } finally {
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
    }
    expect(failure).toHaveBeenCalled();
  });

  it("does not fail scoring work when instrument recording throws", async () => {
    const meter = {
      createCounter: () => ({
        add() {
          throw new Error("synthetic instrument outage");
        },
      }),
    } as unknown as Meter;
    await exercise(createScoringAccessHmacMetrics(meter));
  });

  it("safely no-ops when instrument construction throws", async () => {
    const meter = {
      createCounter() {
        throw new Error("synthetic instrument creation outage");
      },
    } as unknown as Meter;
    await exercise(createScoringAccessHmacMetrics(meter));
  });
});
