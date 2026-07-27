import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  passedPlaywrightTestCount,
  redactedIdentifierHash,
  redisLogicalDatabase,
  retainedArtifacts,
} from "../../scripts/gate-c-access-evidence.js";

describe("Gate C access evidence", () => {
  it("redacts PostgreSQL and Redis identifiers with domain-separated hashes", () => {
    const postgres = redactedIdentifierHash("postgres", "matchday_gate_c_secret");
    const redis = redactedIdentifierHash("redis-namespace", "matchday:test:gate-c:secret:");

    expect(postgres).toMatch(/^[a-f0-9]{64}$/);
    expect(redis).toMatch(/^[a-f0-9]{64}$/);
    expect(postgres).not.toBe(redis);
    expect(postgres).not.toContain("secret");
  });

  it("requires an explicit Redis logical database", () => {
    expect(redisLogicalDatabase("redis://127.0.0.1:6379/14")).toBe(14);
    expect(() => redisLogicalDatabase("redis://127.0.0.1:6379")).toThrow(/explicit logical database/);
  });

  it("counts only fully passed Playwright tests", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  projectName: "phone-chromium",
                  expectedStatus: "passed",
                  results: [{ status: "passed" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(passedPlaywrightTestCount(report, "phone-chromium")).toBe(1);

    report.suites[0]!.specs![0]!.tests![0]!.results[0]!.status = "failed";
    expect(() => passedPlaywrightTestCount(report, "phone-chromium")).toThrow(/did not pass all/);
  });

  it("rejects a passing report from the wrong Playwright project", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  projectName: "wrong-project",
                  expectedStatus: "passed",
                  results: [{ status: "passed" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => passedPlaywrightTestCount(report, "phone-webkit")).toThrow(/project does not match/);
  });

  it("enumerates retained paths with hashes and byte sizes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gate-c-access-evidence-"));
    await mkdir(path.join(directory, "screenshots"));
    await writeFile(path.join(directory, "screenshots", "phone.png"), "image");

    await expect(retainedArtifacts(directory)).resolves.toEqual([
      {
        path: "screenshots/phone.png",
        sha256: "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d",
        size_bytes: 5,
      },
    ]);
  });

  it("rejects symlinks in retained project evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gate-c-access-evidence-"));
    await writeFile(path.join(directory, "target"), "result");
    await symlink(path.join(directory, "target"), path.join(directory, "linked-result"));

    await expect(retainedArtifacts(directory)).rejects.toThrow(/must not contain symlinks/);
  });
});
