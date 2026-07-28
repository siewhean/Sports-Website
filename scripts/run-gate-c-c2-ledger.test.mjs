import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  immutableFileReceipt,
  validateC2DiscoveryOutput,
  validateC2RunReceipt,
  validateC2ScreenshotPaths,
} from "./run-gate-c-c2-ledger.mjs";

const projects = ["gate-c-c2-phone-chromium", "gate-c-c2-phone-webkit", "gate-c-c2-desktop-chromium"];
const screenshotStems = ["canoe-polo", "badminton", "table-tennis", "volleyball", "basketball"].flatMap((sport) => [
  `${sport}-live-scorer`,
  `${sport}-organiser-audit`,
]);

test("Gate C C2 ledger requires the exact project matrix and aggregate count", () => {
  const sourceSha = "a".repeat(40);
  const receipt = {
    artifact_kind: "gate-c-c2-run-evidence",
    source_sha: sourceSha,
    pass_count: 6,
    projects: projects.map((project_name) => ({
      project_name,
      pass_count: 2,
      duration_ms: 1.125,
      evidence_path: `${project_name}/project-evidence.json`,
    })),
  };
  assert.equal(validateC2RunReceipt(receipt, sourceSha).length, 3);
  receipt.projects[1].project_name = "wrong-project";
  assert.throws(() => validateC2RunReceipt(receipt, sourceSha), /invalid for gate-c-c2-phone-webkit/);
});

test("Gate C C2 immutable receipt hashes retained bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c2-bundle-"));
  const file = path.join(directory, "bundle.tar.gz");
  await writeFile(file, "immutable");
  assert.deepEqual(await immutableFileReceipt(file), {
    sha256: "3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7",
    size_bytes: 9,
  });
});

test("Gate C C2 exact-SHA ledger fails closed on incomplete discovery", () => {
  const output = [
    "Listing tests:",
    `  [${projects[0]}] › gate-c-c2-real.spec.ts:1:1 › C2 scoring`,
    `  [${projects[1]}] › gate-c-c2-real.spec.ts:1:1 › C2 scoring`,
    "Total: 2 tests in 1 file",
  ].join("\n");
  assert.throws(() => validateC2DiscoveryOutput(output), /discovered no tests for gate-c-c2-desktop-chromium/);
});

test("Gate C C2 ledger requires each exact scorer and organiser screenshot once", () => {
  const paths = screenshotStems.map((stem) => `playwright/attachments/${stem}-${"a".repeat(40)}.png`);
  assert.deepEqual(validateC2ScreenshotPaths(paths), paths);
  assert.throws(() => validateC2ScreenshotPaths(paths.slice(1)), /found 0/);
  assert.throws(() => validateC2ScreenshotPaths([...paths, paths[0]]), /found 2/);
  assert.throws(() => validateC2ScreenshotPaths(["playwright/unrelated.png"]), /found 0/);
});
