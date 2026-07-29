import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoSecretLikeText,
  createGateCC3ControllableClock,
  verifyGateCC3SafeArtifactTree,
} from "../../scripts/gate-c-c3-evidence.js";

describe("Gate C C3 controllable runner clock", () => {
  it("tracks live system time by default and returns to it after a bounded override", () => {
    let systemNow = Date.parse("2026-07-28T15:00:00.000Z");
    const clock = createGateCC3ControllableClock(() => systemNow);
    expect(clock.now().toISOString()).toBe("2026-07-28T15:00:00.000Z");
    systemNow += 60_000;
    expect(clock.now().toISOString()).toBe("2026-07-28T15:01:00.000Z");

    clock.set("2026-07-29T00:00:00.000Z");
    systemNow += 60_000;
    expect(clock.now().toISOString()).toBe("2026-07-29T00:00:00.000Z");

    clock.reset();
    expect(clock.now().toISOString()).toBe("2026-07-28T15:02:00.000Z");
  });
});

describe("Gate C C3 retained browser artifact safety", () => {
  it.each([
    "set-cookie: scoring_session=raw",
    "Authorization: Basic Zm9vOmJhcg==",
    "x-api-key: raw-key",
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJzY29yZXIifQ", "signature123"].join("."),
    "-----BEGIN PRIVATE KEY-----",
    "https://example.test/score#access=raw",
  ])("rejects secret-like text: %s", (candidate) => {
    expect(() => assertNoSecretLikeText(candidate, "test")).toThrow(/Secret-like evidence value/);
  });

  it("accepts sanitized JSON and PNG evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-safe-artifacts-"));
    await mkdir(path.join(directory, "attachments"));
    await writeFile(path.join(directory, "results.json"), '{"status":"passed"}\n');
    await writeFile(path.join(directory, "attachments", "offline-ready.png"), Buffer.from([137, 80, 78, 71]));
    await expect(verifyGateCC3SafeArtifactTree(directory)).resolves.toBeUndefined();
  });

  it("rejects traces, recordings and unsafe textual artifacts before retention", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-unsafe-artifacts-"));
    await writeFile(path.join(directory, "trace.zip"), "opaque");
    await expect(verifyGateCC3SafeArtifactTree(directory)).rejects.toThrow(/forbids credential-bearing capture/);

    const textDirectory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-unsafe-text-"));
    await writeFile(path.join(textDirectory, "results.json"), '{"header":"set-cookie: session=raw"}\n');
    await expect(verifyGateCC3SafeArtifactTree(textDirectory)).rejects.toThrow(/Secret-like evidence value/);
  });
});
