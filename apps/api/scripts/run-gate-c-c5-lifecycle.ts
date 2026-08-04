import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DurableJobQueue, type JobDefinition } from "@matchday/jobs";
import { Redis } from "ioredis";

import {
  cleanupGateCC5RedisOwnership,
  createGateCC5RedisOwnership,
  gateCC5OwnedRedisKeys,
  prepareGateCC5RedisOwnership,
  type GateCC5RedisCleanupReceipt,
} from "./gate-c-c5-redis-isolation.js";
import { parseGateCC5WorkloadProfile } from "./gate-c-c5-workload-profile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const queueName = "matchday-foundation";
const waitTimeoutMs = 30_000;
const tailLimit = 100;
const sha256 = /^[a-f0-9]{64}$/u;

type LifecycleJobs = {
  "foundation.probe": JobDefinition<
    { correlationId: string; requestedAt: string },
    { correlationId: string; handledAt: string }
  >;
};

type RunningWorker = Readonly<{
  child: ChildProcess;
  tail: string[];
}>;

export type GateCC5LifecycleReceipt = Readonly<{
  artifact_kind: "gate-c-c5-lifecycle-receipt";
  source_sha: string;
  profile_id: string;
  approval_reference_sha256: string;
  executed_at_utc: string;
  probe_job_id_sha256: string;
  redis_namespace_sha256: string;
  producer_stopped_before_cleanup: true;
  worker_stopped_before_cleanup: true;
  owned_key_counts: Readonly<{ before_cleanup: number; after_cleanup: number }>;
  unrelated_guard_preserved: true;
}>;

function sourceSha(): string {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Gate C C5 requires a full source SHA");
  return sha;
}

function requireCleanSourceTree(): void {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error(`Refusing Gate C C5 lifecycle evidence on a dirty source tree:\n${dirty}`);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Gate C C5 Redis URL must use redis:// or rediss://");
  }
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    db: Number(url.pathname.slice(1) || "0"),
    ...(url.username.length === 0 ? {} : { username: url.username }),
    ...(url.password.length === 0 ? {} : { password: url.password }),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

function appendTail(target: string[], chunk: Buffer): void {
  for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
    if (!line) continue;
    target.push(line);
    if (target.length > tailLimit) target.shift();
  }
}

function startWorker(redisUrl: string, queuePrefix: string, parentEnvironment: NodeJS.ProcessEnv): RunningWorker {
  // Spawn the worker process directly. Killing a `pnpm exec` wrapper makes the
  // wrapper report SIGTERM even when its child drained successfully, so the
  // lifecycle harness cannot distinguish graceful worker shutdown from an
  // interrupted process.
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "apps/worker/src/main.ts"], {
    cwd: root,
    env: {
      ...parentEnvironment,
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      OTEL_ENABLED: "false",
      REDIS_URL: redisUrl,
      MATCHDAY_WORKER_QUEUE_PREFIX: queuePrefix,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => appendTail(tail, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendTail(tail, chunk));
  return { child, tail };
}

async function stopWorker(worker: RunningWorker | null): Promise<void> {
  if (!worker?.child.pid) return;
  if (worker.child.exitCode !== null) {
    if (worker.child.exitCode !== 0) {
      throw new Error(`Gate C C5 worker exited with code ${String(worker.child.exitCode)}`);
    }
    return;
  }
  const target = process.platform === "win32" ? worker.child.pid : -worker.child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    if (worker.child.exitCode === 0) return;
    throw new Error("Gate C C5 worker could not receive shutdown signal");
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => worker.child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    process.kill(target, "SIGKILL");
    await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));
  }
  if (worker.child.exitCode !== 0) {
    throw new Error(`Gate C C5 worker exited with code ${String(worker.child.exitCode)}`);
  }
}

async function waitUntil(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gate C C5 ${label} did not complete within ${String(waitTimeoutMs)}ms`);
}

function assertLifecycleReceipt(value: GateCC5LifecycleReceipt, exactSourceSha: string): GateCC5LifecycleReceipt {
  if (value.artifact_kind !== "gate-c-c5-lifecycle-receipt" || value.source_sha !== exactSourceSha) {
    throw new Error("Gate C C5 lifecycle receipt is not bound to the exact source SHA");
  }
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(value.profile_id) || !sha256.test(value.approval_reference_sha256)) {
    throw new Error("Gate C C5 lifecycle receipt has no approved profile");
  }
  if (!sha256.test(value.probe_job_id_sha256) || !sha256.test(value.redis_namespace_sha256)) {
    throw new Error("Gate C C5 lifecycle receipt has malformed hashes");
  }
  if (
    value.producer_stopped_before_cleanup !== true ||
    value.worker_stopped_before_cleanup !== true ||
    value.owned_key_counts.before_cleanup < 1 ||
    value.owned_key_counts.after_cleanup !== 0 ||
    value.unrelated_guard_preserved !== true
  ) {
    throw new Error("Gate C C5 lifecycle receipt does not prove safe queue cleanup");
  }
  return value;
}

export function createGateCC5LifecycleReceipt(input: {
  sourceSha: string;
  profileId: string;
  approvalReference: string;
  probeJobId: string;
  redisNamespace: string;
  cleanup: GateCC5RedisCleanupReceipt;
}): GateCC5LifecycleReceipt {
  if (!input.cleanup.unrelatedGuardPreserved) {
    throw new Error("Gate C C5 lifecycle receipt does not prove safe queue cleanup");
  }
  return assertLifecycleReceipt(
    {
      artifact_kind: "gate-c-c5-lifecycle-receipt",
      source_sha: input.sourceSha,
      profile_id: input.profileId,
      approval_reference_sha256: hash(input.approvalReference),
      executed_at_utc: new Date().toISOString(),
      probe_job_id_sha256: hash(input.probeJobId),
      redis_namespace_sha256: hash(input.redisNamespace),
      producer_stopped_before_cleanup: true,
      worker_stopped_before_cleanup: true,
      owned_key_counts: {
        before_cleanup: input.cleanup.initialOwnedKeyCount,
        after_cleanup: input.cleanup.finalOwnedKeyCount,
      },
      unrelated_guard_preserved: input.cleanup.unrelatedGuardPreserved,
    },
    input.sourceSha,
  );
}

async function evidencePath(exactSourceSha: string, runId: string): Promise<string> {
  const allowedRoot = path.join(root, "artifacts", "qa", "gate-c-c5", exactSourceSha);
  const directory = path.join(allowedRoot, "lifecycle", runId);
  await mkdir(allowedRoot, { recursive: true });
  if ((await realpath(allowedRoot)) !== allowedRoot) {
    throw new Error("Gate C C5 lifecycle artifact root must not traverse symlinks");
  }
  await mkdir(directory, { recursive: true });
  if (!(await realpath(directory)).startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("Gate C C5 lifecycle artifact directory escaped the exact-SHA root");
  }
  return path.join(directory, "lifecycle-receipt.json");
}

export async function runGateCC5Lifecycle(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GateCC5LifecycleReceipt> {
  requireCleanSourceTree();
  const profile = parseGateCC5WorkloadProfile(environment.GATE_C_C5_WORKLOAD_PROFILE_JSON);
  const exactSourceSha = sourceSha();
  const runId = randomUUID();
  const queuePrefix = `matchday-c5-${runId}`;
  const rateLimitNamespace = `matchday:test:gate-c-c5:${runId}:`;
  const redisUrl = environment.TEST_REDIS_URL ?? environment.REDIS_URL ?? "redis://127.0.0.1:6379/15";
  const ownership = createGateCC5RedisOwnership(queuePrefix, queueName, rateLimitNamespace);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  let producer: DurableJobQueue<LifecycleJobs> | null = null;
  let worker: RunningWorker | null = null;
  let producerStopped = false;
  let workerStopped = false;
  let ownershipPrepared = false;
  let cleanupPerformed = false;
  let failure: unknown;
  try {
    await prepareGateCC5RedisOwnership(redis, ownership);
    ownershipPrepared = true;
    producer = new DurableJobQueue<LifecycleJobs>({
      queueName,
      prefix: queuePrefix,
      connection: redisConnection(redisUrl),
      defaultAttempts: 1,
    });
    worker = startWorker(redisUrl, queuePrefix, environment);
    await waitUntil(async () => (await gateCC5OwnedRedisKeys(redis, ownership)).length > 0, "worker startup");
    const job = await producer.enqueue(
      "foundation.probe",
      { correlationId: `c5-lifecycle-${runId}`, requestedAt: new Date().toISOString() },
      { idempotencyKey: `c5-lifecycle-${runId}` },
    );
    await waitUntil(
      async () => (await redis.zscore(`${queuePrefix}:${queueName}:completed`, job.id)) !== null,
      "worker probe",
    );
    await producer.close();
    producerStopped = true;
    await stopWorker(worker);
    workerStopped = true;
    const cleanup = await cleanupGateCC5RedisOwnership(redis, ownership);
    cleanupPerformed = true;
    if (!producerStopped || !workerStopped) throw new Error("Gate C C5 lifecycle cleanup started before shutdown");
    requireCleanSourceTree();
    if (sourceSha() !== exactSourceSha) {
      throw new Error("Gate C C5 source changed during lifecycle execution");
    }
    const receipt = createGateCC5LifecycleReceipt({
      sourceSha: exactSourceSha,
      profileId: profile.profileId,
      approvalReference: profile.approval.reference,
      probeJobId: job.id,
      redisNamespace: rateLimitNamespace,
      cleanup,
    });
    const output = await evidencePath(exactSourceSha, runId);
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error: unknown) {
    failure = error;
    throw new Error("Gate C C5 lifecycle run failed; worker output was not retained", { cause: error });
  } finally {
    let shutdownFailure: unknown;
    if (!producerStopped && producer !== null) {
      try {
        await producer.close();
        producerStopped = true;
      } catch (error: unknown) {
        shutdownFailure = error;
      }
    }
    if (!workerStopped && worker !== null) {
      try {
        await stopWorker(worker);
        workerStopped = true;
      } catch (error: unknown) {
        shutdownFailure ??= error;
      }
    }
    if (ownershipPrepared && !cleanupPerformed && producerStopped && workerStopped) {
      try {
        await cleanupGateCC5RedisOwnership(redis, ownership);
        cleanupPerformed = true;
      } catch (error: unknown) {
        shutdownFailure ??= error;
      }
    }
    await redis.quit().catch(() => undefined);
    if (shutdownFailure !== undefined) {
      throw new Error(
        `Gate C C5 lifecycle cleanup could not complete for isolated namespace ${hash(rateLimitNamespace)}`,
        { cause: shutdownFailure },
      );
    }
    if (failure !== undefined && ownershipPrepared && !cleanupPerformed) {
      throw new Error(
        `Gate C C5 lifecycle failure retained an isolated namespace ${hash(rateLimitNamespace)} because safe cleanup was impossible`,
        { cause: failure },
      );
    }
  }
}

async function main(): Promise<void> {
  const receipt = await runGateCC5Lifecycle();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  });
}
