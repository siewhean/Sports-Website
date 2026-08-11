import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  assertEmptyOwnedRedisNamespace,
  createRedisOwnership,
  isOwnedRedisKey,
  resolveHarnessPorts,
  resolveHarnessProjects,
  resolveHarnessRunCount,
  sha256Identifier,
  unlinkOwnedRedisKeys,
} from "../../scripts/run-phase-4-real-e2e.js";

const queueName = "matchday-phase4-real-e2e-123e4567-e89b-42d3-a456-426614174000";

class FakeRedis {
  readonly keys: Set<string>;
  unlinkCalls: string[][] = [];

  constructor(keys: string[]) {
    this.keys = new Set(keys);
  }

  async scan(...args: [string, "MATCH", string, "COUNT", number]) {
    const [cursor, , pattern] = args;
    const matching = [...this.keys].filter((key) => key.startsWith(pattern.slice(0, -1))).sort();
    const offset = Number(cursor);
    const page = matching.slice(offset, offset + 2);
    const nextCursor = offset + page.length >= matching.length ? "0" : String(offset + page.length);
    return [nextCursor, page] as [string, string[]];
  }

  async unlink(...keys: string[]) {
    this.unlinkCalls.push(keys);
    let removed = 0;
    for (const key of keys) {
      if (this.keys.delete(key)) removed += 1;
    }
    return removed;
  }
}

describe("Phase 4 real E2E Redis ownership", () => {
  it("uses explicit, valid, non-conflicting ports so parallel worktrees do not contend", () => {
    expect(resolveHarnessPorts({})).toEqual({ apiPort: 4101, webPort: 3103 });
    expect(resolveHarnessPorts({ PHASE4_E2E_API_PORT: "4115", PHASE4_E2E_WEB_PORT: "3115" })).toEqual({
      apiPort: 4115,
      webPort: 3115,
    });
    expect(() => resolveHarnessPorts({ PHASE4_E2E_API_PORT: "not-a-port" })).toThrow(/integer port/);
    expect(() => resolveHarnessPorts({ PHASE4_E2E_API_PORT: "1023" })).toThrow(/between/);
    expect(() => resolveHarnessPorts({ PHASE4_E2E_API_PORT: "4115", PHASE4_E2E_WEB_PORT: "4115" })).toThrow(
      /must be different/,
    );
  });

  it("permits a bounded one-run calibration before the required two-run evidence", () => {
    expect(resolveHarnessRunCount({})).toBe(2);
    expect(resolveHarnessRunCount({ PHASE4_E2E_RUNS: "1" })).toBe(1);
    expect(resolveHarnessRunCount({ PHASE4_E2E_RUNS: "2" })).toBe(2);
    expect(() => resolveHarnessRunCount({ PHASE4_E2E_RUNS: "3" })).toThrow(/must be 1 or 2/);
  });

  it("limits a calibration to one recognised browser project without changing the evidence default", () => {
    expect(resolveHarnessProjects({})).toEqual([
      "phase-4-real-phone-chromium",
      "phase-4-real-tablet-webkit",
      "phase-4-real-desktop-chromium",
    ]);
    expect(resolveHarnessProjects({ PHASE4_E2E_PROJECT: "phase-4-real-phone-chromium" })).toEqual([
      "phase-4-real-phone-chromium",
    ]);
    expect(() => resolveHarnessProjects({ PHASE4_E2E_PROJECT: "unknown" })).toThrow(/must be one of/);
  });

  it("derives four exact key families from a canonical UUID queue name", () => {
    const ownership = createRedisOwnership(queueName);

    expect(ownership.rateLimitNameSpace).toBe(
      "matchday:phase4-real-e2e:rate-limit:123e4567-e89b-42d3-a456-426614174000:",
    );
    expect(ownership.scanPatterns).toEqual([
      `bull:${queueName}:*`,
      `bull:${queueName}.dead-letter:*`,
      `matchday:job-cancellation:bull:${queueName}:*`,
      `${ownership.rateLimitNameSpace}*`,
    ]);
    expect(ownership.namespaceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    "matchday-phase4-real-e2e-not-a-uuid",
    "matchday-phase4-real-e2e-123e4567-e89b-12d3-a456-426614174000",
    "matchday-phase4-real-e2e-123E4567-E89B-42D3-A456-426614174000",
    `${queueName}-neighbor`,
  ])("rejects non-canonical queue name %s", (candidate) => {
    expect(() => createRedisOwnership(candidate)).toThrow(/non-canonical/);
  });

  it("owns source, dead-letter, cancellation, and rate-limit keys without owning near-prefix keys", () => {
    const ownership = createRedisOwnership(queueName);
    const owned = [
      `bull:${queueName}:meta`,
      `bull:${queueName}.dead-letter:wait`,
      `matchday:job-cancellation:bull:${queueName}:job-1`,
      `${ownership.rateLimitNameSpace}ip:127.0.0.1`,
    ];
    const unrelated = [
      `bull:${queueName}-neighbor:meta`,
      `bull:${queueName}.dead-letter-neighbor:wait`,
      `matchday:job-cancellation:bull:${queueName}-neighbor:job-1`,
      `${ownership.rateLimitNameSpace.slice(0, -1)}-neighbor:ip:127.0.0.1`,
    ];

    expect(owned.every((key) => isOwnedRedisKey(ownership, key))).toBe(true);
    expect(unrelated.every((key) => !isOwnedRedisKey(ownership, key))).toBe(true);
  });

  it("hashes operational identifiers without retaining the UUID", () => {
    const identifier = queueName.slice("matchday-phase4-real-e2e-".length);
    const redacted = sha256Identifier(identifier);

    expect(redacted).toMatch(/^[0-9a-f]{64}$/);
    expect(redacted).not.toContain(identifier);
  });

  it("refuses a non-empty startup namespace without deleting keys", async () => {
    const ownership = createRedisOwnership(queueName);
    const ownedKey = `bull:${queueName}:meta`;
    const redis = new FakeRedis([ownedKey]);

    await expect(assertEmptyOwnedRedisNamespace(redis as unknown as Redis, ownership)).rejects.toThrow(
      /startup found 1 keys/,
    );
    expect(redis.keys).toEqual(new Set([ownedKey]));
    expect(redis.unlinkCalls).toHaveLength(0);
  });

  it("scans every owned family, unlinks in bounded batches, and preserves near-prefix sentinels", async () => {
    const ownership = createRedisOwnership(queueName);
    const owned = [
      ...Array.from({ length: 205 }, (_, index) => `bull:${queueName}:job-${index}`),
      `bull:${queueName}.dead-letter:meta`,
      `matchday:job-cancellation:bull:${queueName}:job-1`,
      `${ownership.rateLimitNameSpace}ip:127.0.0.1`,
    ];
    const sentinels = [
      `bull:${queueName}-foreign:ttl-sentinel`,
      `bull:${queueName}.dead-letter-foreign:ttl-sentinel`,
      `matchday:job-cancellation:bull:${queueName}-foreign:ttl-sentinel`,
      `${ownership.rateLimitNameSpace.slice(0, -1)}-foreign:ttl-sentinel`,
    ];
    const redis = new FakeRedis([...owned, ...sentinels]);

    await expect(unlinkOwnedRedisKeys(redis as unknown as Redis, ownership)).resolves.toBe(0);
    expect(redis.keys).toEqual(new Set(sentinels));
    expect(redis.unlinkCalls.map((batch) => batch.length)).toEqual([100, 100, 8]);
  });

  it("forbids logical-database-wide deletion and size-based isolation claims in the harness", async () => {
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../scripts/run-phase-4-real-e2e.ts",
    );
    const source = (await readFile(scriptPath, "utf8")).toLowerCase();
    const forbidden = ["flush", "db", "flush", "all", "db", "size"].reduce<string[]>((terms, token, index) => {
      if (index % 2 === 0) terms.push(token);
      else terms[terms.length - 1] += token;
      return terms;
    }, []);

    for (const term of forbidden) expect(source).not.toContain(`.${term}(`);
    expect(source).not.toContain("job_id: event.jobid");
    expect(source).not.toContain("queue name: ${queuename}");
  });
});
