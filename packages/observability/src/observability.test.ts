import { describe, expect, it, vi } from "vitest";

import {
  TELEMETRY_REDACTED_VALUE,
  TraceSpanKind,
  bindObservabilityContext,
  createErrorReporter,
  createLogger,
  getObservabilityContext,
  initializeMetrics,
  initializeTracing,
  runWithObservabilityContext,
  sanitizeForTelemetry,
  sanitizeTelemetryText,
  type ActiveTraceContextAdapter,
  type ErrorReportContext,
  type SpanLike,
  assertWorkloadBudget,
  assertC5OperationBudget,
  assertC5WorkloadProfile,
  C5_WORKLOAD_BUDGETS,
  summarizeWorkload,
} from "./index.js";

describe("C5 workload summaries", () => {
  it("uses deterministic nearest-rank percentiles and separates expected failures", () => {
    const summary = summarizeWorkload([
      { durationMs: 10, outcome: "success" },
      { durationMs: 20, outcome: "success" },
      { durationMs: 30, outcome: "expected_failure" },
      { durationMs: 40, outcome: "unexpected_failure" },
    ]);
    expect(summary).toMatchObject({
      sampleCount: 4,
      successfulCount: 2,
      expectedFailureCount: 1,
      unexpectedFailureCount: 1,
      errorRate: 0.25,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maxMs: 40,
    });
  });

  it("fails closed for invalid samples and budget breaches", () => {
    expect(() => summarizeWorkload([])).toThrow("at least one sample");
    expect(() => summarizeWorkload([{ durationMs: -1, outcome: "success" }])).toThrow("non-negative");
    const summary = summarizeWorkload([{ durationMs: 501, outcome: "unexpected_failure" }]);
    expect(() => assertWorkloadBudget(summary, { maxP95Ms: 500, maxUnexpectedErrorRate: 0 })).toThrow("exceeds");
  });

  it("requires an approved, bounded pilot profile before generating C5 traffic", () => {
    const profile = {
      profileId: "pilot-20-scorekeepers",
      durationSeconds: 300,
      scorekeeperCount: 20,
      publicReaderCount: 40,
      organiserWorkerCount: 2,
      approval: {
        owner: "Event Operations",
        approvedAtUtc: "2026-08-04T00:00:00Z",
        reference: "OPS-42",
      },
    } as const;
    expect(() => assertC5WorkloadProfile(profile)).not.toThrow();
    expect(() => assertC5WorkloadProfile({ ...profile, publicReaderCount: 0 })).toThrow("publicReaderCount");
    expect(() => assertC5WorkloadProfile({ ...profile, approval: { ...profile.approval, reference: " " } })).toThrow(
      "approval reference",
    );
    expect(() =>
      assertC5WorkloadProfile({ ...profile, approval: { ...profile.approval, approvedAtUtc: "today" } }),
    ).toThrow("approval timestamp");
    expect(() =>
      assertC5WorkloadProfile({ ...profile, approval: { ...profile.approval, approvedAtUtc: "2026-02-30T00:00:00Z" } }),
    ).toThrow("approval timestamp");
  });

  it("binds every C5 operation to its documented fail-closed budget", () => {
    const withinScoreWriteBudget = summarizeWorkload([{ durationMs: 500, outcome: "success" }]);
    expect(() =>
      assertC5OperationBudget("score_event_acknowledgement", withinScoreWriteBudget, { passed: true }),
    ).not.toThrow();
    expect(C5_WORKLOAD_BUDGETS.public_result_convergence.maxP95Ms).toBe(2_000);
    expect(() =>
      assertC5OperationBudget(
        "public_current_conditional_read",
        summarizeWorkload([{ durationMs: 501, outcome: "success" }]),
        { passed: true },
      ),
    ).toThrow("exceeds");
    expect(() =>
      assertC5OperationBudget("lease_takeover", summarizeWorkload([{ durationMs: 1, outcome: "success" }]), {
        passed: false,
        failureCode: "stale_generation_accepted",
      }),
    ).toThrow("correctness oracle failed: stale_generation_accepted");
  });
});

describe("structured logging and redaction", () => {
  it("redacts case-insensitive secrets at arbitrary depth without mutating input", () => {
    const input = {
      request: {
        headers: {
          Authorization: "Bearer live-token",
          Cookie: "session=private",
          "X-API-Key": "live-key",
        },
      },
      nested: {
        deeper: {
          password: "hunter2",
          refresh_token: "refresh-secret",
          email: "person@example.com",
          safe: "visible",
        },
      },
    };
    const lines: string[] = [];
    const logger = createLogger(
      { level: "info", service: "test", environment: "test" },
      { write: (message) => lines.push(message) },
    );

    logger.info(input, "received");

    const output = JSON.parse(lines[0] ?? "{}") as typeof input & { msg: string };
    expect(output.request.headers.Authorization).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.request.headers.Cookie).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.request.headers["X-API-Key"]).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.nested.deeper.password).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.nested.deeper.refresh_token).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.nested.deeper.email).toBe(TELEMETRY_REDACTED_VALUE);
    expect(output.nested.deeper.safe).toBe("visible");
    expect(input.nested.deeper.password).toBe("hunter2");
  });

  it("emits structured JSON at standard operational levels", () => {
    const lines: string[] = [];
    const logger = createLogger(
      { level: "debug", service: "api", environment: "test" },
      { write: (message) => lines.push(message) },
    );

    logger.debug({ event: "debug-event" });
    logger.info({ event: "info-event" });
    logger.warn({ event: "warn-event" });
    logger.error({ event: "error-event" });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 20, service: "api", event: "debug-event" }),
      expect.objectContaining({ level: 30, service: "api", event: "info-event" }),
      expect.objectContaining({ level: 40, service: "api", event: "warn-event" }),
      expect.objectContaining({ level: 50, service: "api", event: "error-event" }),
    ]);
  });

  it("handles circular objects, buffers, and error causes safely", () => {
    const circular: Record<string, unknown> = { token: "secret" };
    circular.self = circular;
    const error = new Error("outer", { cause: { api_key: "secret", detail: "safe" } });

    expect(sanitizeForTelemetry({ circular, bytes: Buffer.from("secret"), error })).toEqual({
      circular: { token: TELEMETRY_REDACTED_VALUE, self: "[Circular]" },
      bytes: "[Buffer 6 bytes]",
      error: expect.objectContaining({
        name: "Error",
        message: "outer",
        cause: { api_key: TELEMETRY_REDACTED_VALUE, detail: "safe" },
      }),
    });
  });

  it("does not invoke getters and catches fuzzy secret keys and message credentials", () => {
    const getter = vi.fn(() => {
      throw new Error("getter must not run");
    });
    const input = {
      authToken: "secret",
      new_password_hash: "secret-hash",
      detail: "authorization: Bearer live-token for person@example.com",
      get dangerous() {
        return getter();
      },
    };

    expect(sanitizeForTelemetry(input)).toEqual({
      authToken: TELEMETRY_REDACTED_VALUE,
      new_password_hash: TELEMETRY_REDACTED_VALUE,
      detail: "authorization=[REDACTED] [REDACTED] for [REDACTED_EMAIL]",
      dangerous: "[Accessor omitted]",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(sanitizeTelemetryText("password=hunter2 jwt eyJabcdefgh.abcdefgh.abcdefgh")).toBe(
      "password=[REDACTED] jwt [REDACTED]",
    );
  });

  it("terminates cyclic Error causes without exposing secrets", () => {
    const error = new Error("failed with token=private");
    error.cause = error;

    expect(sanitizeForTelemetry(error)).toMatchObject({
      name: "Error",
      message: "failed with token=[REDACTED]",
      cause: "[Circular]",
    });
  });

  it("adds active request, job, and trace correlation fields", () => {
    const lines: string[] = [];
    const logger = createLogger(
      { level: "info", service: "worker", environment: "test" },
      { write: (message) => lines.push(message) },
    );

    runWithObservabilityContext({ requestId: "req-1", jobId: "job-2", traceId: "a".repeat(32) }, () =>
      logger.info("processing"),
    );

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      requestId: "req-1",
      jobId: "job-2",
      traceId: "a".repeat(32),
    });
  });
});

describe("context propagation", () => {
  it("merges nested context and restores the parent", () => {
    runWithObservabilityContext({ requestId: "req-1", correlationId: "corr-1" }, () => {
      runWithObservabilityContext({ jobId: "job-1" }, () => {
        expect(getObservabilityContext()).toEqual({
          requestId: "req-1",
          correlationId: "corr-1",
          jobId: "job-1",
        });
      });
      expect(getObservabilityContext()).toEqual({ requestId: "req-1", correlationId: "corr-1" });
    });
    expect(getObservabilityContext()).toEqual({});
  });

  it("captures context for event and queue callbacks", () => {
    const callback = runWithObservabilityContext({ jobId: "job-9" }, () =>
      bindObservabilityContext(() => getObservabilityContext().jobId),
    );
    expect(callback()).toBe("job-9");
  });
});

describe("provider-neutral error reporting", () => {
  it("passes correlation data and sanitized attributes to a provider", async () => {
    let capturedContext: ErrorReportContext | undefined;
    let capturedError: unknown;
    const provider = {
      captureException: vi.fn((error: unknown, context: ErrorReportContext) => {
        capturedError = error;
        capturedContext = context;
      }),
    };
    const reporter = createErrorReporter(provider);

    await runWithObservabilityContext({ requestId: "req-7", jobId: "job-7" }, () =>
      reporter.reportError(new Error("failed for person@example.com with token=private"), {
        handled: false,
        severity: "fatal",
        attributes: { action: "publish", credentials: { token: "private" } },
        fingerprint: ["publish", "failed-person@example.com"],
      }),
    );

    expect(provider.captureException).toHaveBeenCalledOnce();
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe("failed for [REDACTED_EMAIL] with token=[REDACTED]");
    expect(capturedContext).toMatchObject({
      requestId: "req-7",
      jobId: "job-7",
      handled: false,
      severity: "fatal",
      attributes: {
        action: "publish",
        credentials: TELEMETRY_REDACTED_VALUE,
      },
      fingerprint: ["publish", "[REDACTED_EMAIL]"],
    });
  });

  it("never throws when a provider or flush operation fails", async () => {
    const reporter = createErrorReporter({
      captureException: () => {
        throw new Error("provider unavailable");
      },
      flush: () => Promise.reject(new Error("flush unavailable")),
    });

    await expect(reporter.reportError(new Error("application error"))).resolves.toBeUndefined();
    await expect(reporter.reportMessage("warning")).resolves.toBeUndefined();
    await expect(reporter.flush(100)).resolves.toBeUndefined();
    await expect(createErrorReporter().reportError(new Error("noop"))).resolves.toBeUndefined();
  });
});

describe("OpenTelemetry-compatible metrics foundation", () => {
  it("creates instruments through a structurally compatible provider", () => {
    const add = vi.fn();
    const record = vi.fn();
    const provider = {
      getMeter: vi.fn(() => ({
        createCounter: vi.fn(() => ({ add })),
        createHistogram: vi.fn(() => ({ record })),
        createUpDownCounter: vi.fn(() => ({ add })),
      })),
    };
    const metrics = initializeMetrics({
      serviceName: "api",
      serviceVersion: "1.2.3",
      provider,
    });

    metrics.counter("http.server.request.count").add(1, { route: "/status" });
    metrics.histogram("http.server.request.duration", { unit: "ms" }).record(12, {
      route: "/status",
    });

    expect(provider.getMeter).toHaveBeenCalledWith("api", "1.2.3");
    expect(add).toHaveBeenCalledWith(1, { route: "/status" });
    expect(record).toHaveBeenCalledWith(12, { route: "/status" });
  });

  it("falls back to safe no-op instruments", () => {
    const noProvider = initializeMetrics({ serviceName: "api" });
    expect(() => noProvider.counter("requests").add(1)).not.toThrow();

    const throwingProvider = initializeMetrics({
      serviceName: "api",
      provider: {
        getMeter: () => {
          throw new Error("not configured");
        },
      },
    });
    expect(() => throwingProvider.histogram("duration").record(1)).not.toThrow();

    const brokenInstrument = initializeMetrics({
      serviceName: "api",
      provider: {
        getMeter: () => ({
          createCounter: () => ({
            add: () => {
              throw new Error("exporter down");
            },
          }),
          createHistogram: () => ({ record: () => undefined }),
          createUpDownCounter: () => ({ add: () => undefined }),
        }),
      },
    });
    expect(() => brokenInstrument.counter("requests").add(1)).not.toThrow();
  });
});

describe("OpenTelemetry-compatible tracing foundation", () => {
  it("propagates span IDs alongside HTTP/job IDs and ends successful spans", async () => {
    const end = vi.fn();
    const span: SpanLike = {
      setAttribute: vi.fn(function (this: SpanLike) {
        return this;
      }),
      setAttributes: vi.fn(function (this: SpanLike) {
        return this;
      }),
      addEvent: vi.fn(function (this: SpanLike) {
        return this;
      }),
      setStatus: vi.fn(function (this: SpanLike) {
        return this;
      }),
      recordException: vi.fn(),
      spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
      end,
    };
    const provider = {
      getTracer: vi.fn(() => ({ startSpan: vi.fn(() => span) })),
    };
    const tracing = initializeTracing({ serviceName: "worker", provider });

    const context = await runWithObservabilityContext({ requestId: "req-1", jobId: "job-1" }, () =>
      tracing.withSpan("job.process", { kind: TraceSpanKind.Consumer }, async () => {
        await Promise.resolve();
        return { ...getObservabilityContext() };
      }),
    );

    expect(context).toEqual({
      requestId: "req-1",
      jobId: "job-1",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    });
    expect(end).toHaveBeenCalledOnce();
  });

  it("records exceptions, ends spans, and preserves application errors", async () => {
    const recordException = vi.fn();
    const setStatus = vi.fn(function (this: SpanLike) {
      return this;
    });
    const end = vi.fn();
    const span: SpanLike = {
      setAttribute() {
        return this;
      },
      setAttributes() {
        return this;
      },
      addEvent() {
        return this;
      },
      setStatus,
      recordException,
      spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }),
      end,
    };
    const tracing = initializeTracing({
      serviceName: "api",
      provider: { getTracer: () => ({ startSpan: () => span }) },
    });
    const applicationError = new Error("boom for person@example.com with token=private", {
      cause: { password: "secret" },
    });

    await expect(
      tracing.withSpan("request", { kind: TraceSpanKind.Server }, async () => {
        throw applicationError;
      }),
    ).rejects.toBe(applicationError);
    const recorded = recordException.mock.calls[0]?.[0] as Error;
    expect(recorded).toBeInstanceOf(Error);
    expect(recorded).not.toBe(applicationError);
    expect(recorded.message).toBe("boom for [REDACTED_EMAIL] with token=[REDACTED]");
    expect(recorded.cause).toEqual({ password: TELEMETRY_REDACTED_VALUE });
    expect(setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(end).toHaveBeenCalledOnce();
  });

  it("uses a no-op tracer when no provider is configured", () => {
    const tracing = initializeTracing({ serviceName: "api" });
    expect(tracing.withSpan("request", {}, () => "ok")).toBe("ok");
  });

  it("adapts OpenTelemetry active context for parentage and callback scope", () => {
    const parentContext = { name: "parent" };
    const childContext = { name: "child" };
    const startSpan = vi.fn((): SpanLike => ({
      setAttribute() {
        return this;
      },
      setAttributes() {
        return this;
      },
      addEvent() {
        return this;
      },
      setStatus() {
        return this;
      },
      recordException: vi.fn(),
      spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }),
      end: vi.fn(),
    }));
    const active = vi.fn(() => parentContext);
    const setSpan = vi.fn(() => childContext);
    const withContext = vi.fn();
    const activeContext: ActiveTraceContextAdapter = {
      active,
      setSpan,
      with<T>(context: unknown, callback: () => T): T {
        withContext(context, callback);
        return callback();
      },
    };
    const tracing = initializeTracing({
      serviceName: "api",
      provider: { getTracer: () => ({ startSpan }) },
      activeContext,
    });

    expect(tracing.withSpan("request", { kind: TraceSpanKind.Server }, () => "ok")).toBe("ok");
    expect(startSpan).toHaveBeenCalledWith("request", { kind: TraceSpanKind.Server }, parentContext);
    expect(setSpan).toHaveBeenCalledWith(parentContext, expect.any(Object));
    expect(withContext).toHaveBeenCalledWith(childContext, expect.any(Function));
  });
});
