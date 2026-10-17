import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCopy, findBannedCopy } from "./check-copy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the repository copy uses plain words", () => {
  const { violations, filesScanned } = checkCopy(repoRoot);
  assert.ok(filesScanned > 50, `expected the copy modules to be scanned, got ${filesScanned}`);
  assert.deepEqual(violations, []);
});

test("a banned term in a sentence fails", () => {
  const findings = findBannedCopy('export const copy = { title: "Review the schedule revision" };');
  assert.deepEqual(
    findings.map((finding) => finding.term),
    ["revision"],
  );
});

test("each banned term is found, whatever its case", () => {
  const source = `export const copy = [
    "Canonical match events",
    "Uses the deterministic engine",
    "Pinned evidence for review",
    "The solver gave up",
    "Two revisions differ",
    "Public projection updated",
  ];`;
  assert.deepEqual(
    findBannedCopy(source).map((finding) => finding.term),
    ["canonical", "deterministic", "pinned evidence", "solver", "revisions", "projection"],
  );
});

test("identifiers, routes, placeholders and developer errors pass", () => {
  const source = `
    const key = "revision";
    const route = "/schedule/revisions";
    const status = "revision_conflict";
    const copy = "Private draft {revision}";
    throw new Error("Public projection is malformed");
    throw new PublicDataUnavailableError(cause ? cause.message : "Public projection is malformed");
  `;
  assert.deepEqual(findBannedCopy(source), []);
});

test("template literals are checked too", () => {
  const findings = findBannedCopy("const text = `Schedule revision ${number} saved`;");
  assert.equal(findings.length, 1);
});
