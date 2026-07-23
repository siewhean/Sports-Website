import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { parseConfig } from "@matchday/config";
import { populatedUpgradeTestName, populatedUpgradeTimeoutMs } from "../tests/integration/migration-test-settings.js";

const repetitions = 5;
const config = parseConfig(process.env);
const sql = postgres(config.databaseUrl, { max: 1 });

let postgresVersion: string;
try {
  const [version] = await sql<{ server_version: string }[]>`SHOW server_version`;
  postgresVersion = version?.server_version ?? "unknown";
} finally {
  await sql.end({ timeout: 2 });
}

const durationsMs: number[] = [];
for (let run = 1; run <= repetitions; run += 1) {
  const startedAt = performance.now();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/integration/migrations.test.ts",
      "--testNamePattern",
      populatedUpgradeTestName,
      "--no-cache",
      "--no-file-parallelism",
      "--maxWorkers=1",
      "--reporter=verbose",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, RUN_INFRA_TESTS: "1" },
      stdio: "inherit",
    },
  );
  const durationMs = performance.now() - startedAt;
  durationsMs.push(durationMs);

  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(
      JSON.stringify({
        status: "FAIL",
        failedRun: run,
        exitStatus: result.status,
        signal: result.signal,
        durationsMs: durationsMs.map((duration) => Math.round(duration)),
      }),
    );
    process.exit(result.status ?? 1);
  }
}

const sortedDurations = [...durationsMs].sort((left, right) => left - right);
const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)]!;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      testName: populatedUpgradeTestName,
      repetitions,
      uncached: true,
      harnessLoad: "serial repetitions with one Vitest worker",
      externalPostgresLoad: "not measured; record the host workload with retained evidence",
      postgresVersion,
      timeoutMs: populatedUpgradeTimeoutMs,
      durationMeasurement: "wall-clock child-process duration, including Vitest startup and cleanup",
      minDurationMs: Math.round(sortedDurations[0]!),
      medianDurationMs: Math.round(medianDuration),
      maxDurationMs: Math.round(sortedDurations.at(-1)!),
      durationsMs: durationsMs.map((duration) => Math.round(duration)),
    },
    null,
    2,
  ),
);
