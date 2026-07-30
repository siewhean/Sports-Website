import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanGateCC5Artifacts } from "./scan-gate-c-c5-artifacts.mjs";

const sourceSha = "b".repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-c-c5-artifacts-"));
  await mkdir(path.join(root, "nested"));
  return root;
}

test("clean C5 artifacts receive deterministic hashes", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "report.json"), '{"status":"passed"}\n');
    await writeFile(path.join(root, "nested", "metrics.log"), "p95=120\n");
    const first = await scanGateCC5Artifacts(root, sourceSha);
    const second = await scanGateCC5Artifacts(root, sourceSha);

    assert.deepEqual(second, first);
    assert.equal(first.entries.length, 2);
    assert.match(first.treeSha256, /^[a-f0-9]{64}$/u);
    assert.match(first.receiptSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret-like and private artifact content fails closed", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "unsafe.log"), "Authorization: Bearer abc.def.ghi\n");
    await assert.rejects(scanGateCC5Artifacts(root, sourceSha), /Secret or private data/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked evidence is rejected", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink permissions vary on Windows");
    return;
  }
  const root = await fixture();
  try {
    await writeFile(path.join(root, "source.txt"), "safe\n");
    await symlink(path.join(root, "source.txt"), path.join(root, "nested", "alias.txt"));
    await assert.rejects(scanGateCC5Artifacts(root, sourceSha), /symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid source SHAs are rejected", async () => {
  const root = await fixture();
  try {
    await assert.rejects(scanGateCC5Artifacts(root, "not-a-sha"), /exact source SHA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
