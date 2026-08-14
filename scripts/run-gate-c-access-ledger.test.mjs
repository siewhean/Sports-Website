import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hashFilesForTest,
  requiredInfrastructureServices,
  requiredLocalCommandLabels,
  validateRunReceipt,
} from "./run-gate-c-access-ledger.mjs";

test("Gate C access ledger starts every integration dependency", () => {
  assert.deepEqual(requiredInfrastructureServices, ["postgres", "redis", "mailpit"]);
});

test("Gate C access ledger includes the complete local acceptance command set", () => {
  assert.deepEqual(requiredLocalCommandLabels, [
    "node-version",
    "pnpm-version",
    "frozen-install",
    "lockfile-clean",
    "clean-outputs",
    "format",
    "lint",
    "typecheck",
    "unit",
    "migrations",
    "backup",
    "integration",
    "fixtures",
    "phase2",
    "phase3",
    "phase4",
    "openapi",
    "audit",
    "secrets",
    "build",
    "deploy-manifest",
    "asset-origin",
    "browser-install",
    "e2e",
    "a11y",
    "visual",
    "diff-check",
    "check",
  ]);
});

test("Gate C access ledger hashes retained files with byte sizes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-access-ledger-"));
  await mkdir(path.join(directory, "nested"));
  await writeFile(path.join(directory, "nested", "receipt.json"), "{}\n");

  assert.deepEqual(await hashFilesForTest(directory), [
    {
      path: "nested/receipt.json",
      sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
      size_bytes: 3,
    },
  ]);
});

test("Gate C access ledger rejects symlinked evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-access-ledger-"));
  await writeFile(path.join(directory, "target"), "retained");
  await symlink(path.join(directory, "target"), path.join(directory, "link"));

  await assert.rejects(() => hashFilesForTest(directory), /must not contain symlinks/);
});

test("Gate C access ledger requires the exact project matrix", () => {
  const sourceSha = "a".repeat(40);
  const names = ["gate-c-access-phone-chromium", "gate-c-access-phone-webkit", "gate-c-access-desktop-chromium"];
  const receipt = {
    source_sha: sourceSha,
    pass_count: 3,
    projects: names.map((project_name) => ({
      project_name,
      pass_count: 1,
      duration_ms: 1.25,
      evidence_path: `${project_name}/project-evidence.json`,
    })),
  };
  assert.equal(validateRunReceipt(receipt, sourceSha).length, 3);

  receipt.projects[1].project_name = "wrong-project";
  assert.throws(() => validateRunReceipt(receipt, sourceSha), /invalid for gate-c-access-phone-webkit/);
});
