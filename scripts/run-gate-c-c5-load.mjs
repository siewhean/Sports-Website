#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gateCC5WorkloadProfile, selectGateCC5Operation } from "./gate-c-c5-workload-profiles.mjs";

const secretKeyPattern = /(?:authorization|cookie|password|secret|token|access[_-]?key|api[_-]?key)/iu;
const unsafeUrlPattern = /#|(?:^|[?&])(?:access|token|secret|password|api[_-]?key)=/iu;

function argumentMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected C5 load argument: ${value}`);
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) result.set(rawKey, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result.set(rawKey, argv[++index]);
    else result.set(rawKey, "true");
  }
  return result;
}

function numberArgument(args, name, fallback, minimum = 1) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${name} must be at least ${minimum}`);
  return value;
}

function sourceSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to determine exact source SHA");
  const value = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("Exact source SHA is invalid");
  return value;
}

export function seededRandom(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error("Percentile must be in [0,1]");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
}

function assertSafeTarget(operation, target) {
  if (!target || typeof target !== "object") throw new Error(`Missing target for ${operation}`);
  if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/u.test(target.method ?? "")) {
    throw new Error(`Unsupported method for ${operation}`);
  }
  if (typeof target.path !== "string" || !target.path.startsWith("/") || unsafeUrlPattern.test(target.path)) {
    throw new Error(`Unsafe target path for ${operation}`);
  }
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    if (secretKeyPattern.test(key) || secretKeyPattern.test(String(value))) {
      throw new Error(`Credential-bearing headers are forbidden for ${operation}`);
    }
  }
  if (
    target.expectedStatuses !== undefined &&
    (!Array.isArray(target.expectedStatuses) ||
      target.expectedStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599))
  ) {
    throw new Error(`Invalid expected statuses for ${operation}`);
  }
}

export function validateTargetManifest(manifest, requiredOperations) {
  if (manifest?.schemaVersion !== 1 || !manifest.operations || typeof manifest.operations !== "object") {
    throw new Error("Gate C C5 target manifest must use schemaVersion 1");
  }
  for (const operation of requiredOperations) assertSafeTarget(operation, manifest.operations[operation]);
  return manifest;
}

function substitute(value, context) {
  if (typeof value === "string") {
    return value.replace(/\{([a-z0-9_]+)\}/giu, (_, key) => {
      if (!(key in context)) throw new Error(`Missing C5 target placeholder: ${key}`);
      return encodeURIComponent(String(context[key]));
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child, context)]));
  }
  return value;
}

function requestContext(profile, sequence, random) {
  const division = Math.floor(random() * profile.divisions) + 1;
  const match = Math.floor(random() * Math.max(profile.teams * 2, 1)) + 1;
  return {
    sequence,
    competition_id: `c5-${profile.id}-competition`,
    division_id: `division-${division}`,
    match_id: `match-${match}`,
    repair_id: `repair-${Math.floor(sequence / 10) + 1}`,
    request_id: createHash("sha256").update(`${profile.id}:${sequence}`).digest("hex").slice(0, 32),
  };
}

function targetRate(mode, elapsedSeconds, durationSeconds, profile) {
  if (mode === "burst") return profile.burstRequestsPerSecond;
  if (mode === "ramp") return Math.max(1, profile.targetRequestsPerSecond * (elapsedSeconds / durationSeconds));
  return profile.targetRequestsPerSecond;
}

async function measuredFetch({ baseUrl, operation, target, context, timeoutMs }) {
  const path = substitute(target.path, context);
  const url = new URL(path, baseUrl);
  if (unsafeUrlPattern.test(url.toString())) throw new Error(`Unsafe generated URL for ${operation}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: target.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": context.request_id,
        ...(target.headers ?? {}),
      },
      body: ["GET", "HEAD"].includes(target.method)
        ? undefined
        : JSON.stringify(substitute(target.body ?? {}, context)),
      signal: controller.signal,
      redirect: "error",
    });
    await response.arrayBuffer();
    return { status: response.status, durationMs: performance.now() - started, error: null };
  } catch (error) {
    return {
      status: 0,
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.name : "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarise(samples) {
  const durations = samples.map((sample) => sample.durationMs);
  const statuses = {};
  for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
  return {
    requestCount: samples.length,
    successCount: samples.filter((sample) => sample.accepted).length,
    failureCount: samples.filter((sample) => !sample.accepted).length,
    statuses,
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      maximum: durations.length ? Math.max(...durations) : null,
    },
  };
}

export async function runGateCC5Load(options) {
  const profile = gateCC5WorkloadProfile(options.profileId);
  const requiredOperations = Object.entries(profile.operationWeights)
    .filter(([, weight]) => weight > 0)
    .map(([operation]) => operation);
  const manifest = validateTargetManifest(options.targetManifest, requiredOperations);
  const random = seededRandom(options.seed);
  const samples = [];
  const inFlight = new Set();
  const startedAt = new Date();
  const started = performance.now();
  let sequence = 0;
  let nextDispatch = started;

  const dispatch = () => {
    const operation = selectGateCC5Operation(profile, random());
    const target = manifest.operations[operation];
    const context = requestContext(profile, sequence++, random);
    const request = measuredFetch({
      baseUrl: options.baseUrl,
      operation,
      target,
      context,
      timeoutMs: options.timeoutMs,
    })
      .then((result) => {
        const expected = target.expectedStatuses ?? [200, 201, 202, 204, 304, 409, 422];
        samples.push({ operation, ...result, accepted: expected.includes(result.status) });
      })
      .finally(() => inFlight.delete(request));
    inFlight.add(request);
  };

  while ((performance.now() - started) / 1_000 < options.durationSeconds) {
    const elapsedSeconds = (performance.now() - started) / 1_000;
    const rate = targetRate(options.mode, elapsedSeconds, options.durationSeconds, profile);
    const intervalMs = 1_000 / rate;
    const now = performance.now();
    while (nextDispatch <= now && inFlight.size < options.maximumConcurrency) {
      dispatch();
      nextDispatch += intervalMs;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, nextDispatch - performance.now()))));
  }
  await Promise.all(inFlight);

  const byOperation = Object.fromEntries(
    requiredOperations.map((operation) => [operation, summarise(samples.filter((sample) => sample.operation === operation))]),
  );
  const summary = summarise(samples);
  const receipt = {
    schemaVersion: 1,
    artifactKind: "gate-c-c5-load-receipt",
    sourceSha: options.sourceSha,
    profileId: profile.id,
    mode: options.mode,
    seed: String(options.seed),
    startedAt: startedAt.toISOString(),
    durationSeconds: options.durationSeconds,
    maximumConcurrency: options.maximumConcurrency,
    baseOriginSha256: createHash("sha256").update(new URL(options.baseUrl).origin).digest("hex"),
    summary,
    operations: byOperation,
  };
  const receiptSha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return { ...receipt, receiptSha256 };
}

async function main() {
  const args = argumentMap(process.argv.slice(2));
  const targetPath = args.get("targets");
  if (!targetPath) throw new Error("--targets is required");
  const targetManifest = JSON.parse(await readFile(targetPath, "utf8"));
  const options = {
    baseUrl: args.get("base-url") ?? "http://127.0.0.1:3001",
    profileId: args.get("profile") ?? "small",
    mode: args.get("mode") ?? "constant-arrival",
    durationSeconds: numberArgument(args, "duration-seconds", 30),
    maximumConcurrency: numberArgument(args, "maximum-concurrency", 64),
    timeoutMs: numberArgument(args, "timeout-ms", 15_000),
    seed: args.get("seed") ?? "gate-c-c5",
    sourceSha: sourceSha(),
    targetManifest,
  };
  if (!new Set(["constant-arrival", "ramp", "burst"]).has(options.mode)) {
    throw new Error("--mode must be constant-arrival, ramp, or burst");
  }
  const receipt = await runGateCC5Load(options);
  const output = args.get("output");
  if (output) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.summary.failureCount > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
