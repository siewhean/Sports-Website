import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { isLockTimeoutError, isStatementTimeoutError, runWithLockRetry } from "../../src/migrations.js";

const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("migration lock retry", () => {
  it("retries lock timeouts with exponential backoff, then succeeds", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(lockTimeout)
      .mockRejectedValueOnce(lockTimeout)
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = logger();
    await expect(
      runWithLockRetry("0069_example.sql", attempt, {
        retries: 3,
        baseDelayMs: 100,
        logger: log,
        sleep,
        random: () => 0.5,
      }),
    ).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("0069_example.sql hit lock_timeout (attempt 1/4)"));
  });

  it("fails with a clear error once retries are exhausted", async () => {
    const attempt = vi.fn().mockRejectedValue(lockTimeout);
    await expect(
      runWithLockRetry("0069_example.sql", attempt, {
        retries: 1,
        baseDelayMs: 1,
        logger: logger(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/0069_example\.sql could not acquire its locks within lock_timeout after 2 attempt/u);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures, including statement timeouts", async () => {
    const statementTimeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const attempt = vi.fn().mockRejectedValue(statementTimeout);
    await expect(
      runWithLockRetry("0069_example.sql", attempt, { retries: 3, baseDelayMs: 1, logger: logger() }),
    ).rejects.toBe(statementTimeout);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(isStatementTimeoutError(statementTimeout)).toBe(true);
    expect(isLockTimeoutError(statementTimeout)).toBe(false);
  });

  it("sets lock and statement timeouts inside every migration transaction, after the advisory lock", async () => {
    const source = await readFile(new URL("../../src/migrations.ts", import.meta.url), "utf8");
    const advisory = source.indexOf("SELECT pg_advisory_lock(");
    expect(source.indexOf("SET lock_timeout = ${lockTimeoutMs}")).toBeGreaterThan(advisory);
    expect(source).toContain("SET LOCAL lock_timeout = ${lockTimeoutMs}");
    expect(source).toContain("SET LOCAL statement_timeout = ${statementTimeoutMs}");
  });
});
