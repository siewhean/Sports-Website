import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoSecretLikeText,
  createGateCC3ControllableClock,
  gateCC3ScenarioObservationKeys,
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

describe("Gate C C3 real-journey oracle", () => {
  it("requires the retained page-refresh receipt to prove a real reload", () => {
    expect(gateCC3ScenarioObservationKeys.page_refresh).toEqual([
      "recovered_command_count",
      "refresh_mechanism",
      "performance_navigation_type",
    ]);
  });

  it("requires the retained worker-update receipt to prove post-activation preparation", () => {
    expect(gateCC3ScenarioObservationKeys.service_worker_update).toEqual([
      "active_version",
      "waiting_version",
      "activation_deferred",
      "preparation_after_controller_change",
    ]);
  });

  it("binds the final result snapshot to the isolated finalisation aggregate", async () => {
    const source = await readFile(new URL("../../scripts/run-phase-2-real-e2e.ts", import.meta.url), "utf8");

    expect(source).toContain('["match_started", "period_change", "goal", "finalisation"]');
    expect(source).toContain("resultSnapshots[0]?.count !== (index === 7 ? 1 : 0)");
  });

  it("accepts only the explicit resolved-before-discard stream for the sign-out race", async () => {
    const source = await readFile(new URL("../../scripts/run-phase-2-real-e2e.ts", import.meta.url), "utf8");

    expect(source).toContain('index === 0 && observedEventTypes === [...configuredExpected, "incident"].join(",")');
    expect(source).toContain('? [...configuredExpected, "incident"]');
    expect(source).toContain('observedEventTypes !== expected.join(",")');
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
