#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const secretPatterns = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /bearer\s+[a-z0-9._~+/=-]+/iu,
  /(?:authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/iu,
  /eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/iu,
  /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/iu,
  /redis:\/\/[^/\s]+:[^@\s]+@/iu,
  /#access=/iu,
  /__Secure-matchday-offline-grant/iu,
  /(?:email|phone|raw_device_id|client_ip|resume_secret|fallback_code)\s*[:=]\s*[^\s,;]+/iu,
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCleanText(text, label) {
  const matched = secretPatterns.find((pattern) => pattern.test(text));
  if (matched) throw new Error(`Secret or private data detected in C5 artifact: ${label}`);
}

async function walk(root, relative = "") {
  const directory = path.join(root, relative);
  const children = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const child of children) {
    const next = path.join(relative, child.name);
    const absolute = path.join(root, next);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`C5 evidence cannot contain symlinks: ${next}`);
    if (metadata.isDirectory()) files.push(...(await walk(root, next)));
    else if (metadata.isFile()) files.push(next.split(path.sep).join("/"));
    else throw new Error(`Unsupported C5 evidence entry: ${next}`);
  }
  return files.sort();
}

export async function scanGateCC5Artifacts(root, sourceSha) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("C5 artifact scan requires an exact source SHA");
  const canonicalRoot = await realpath(root);
  const entries = [];
  for (const relative of await walk(canonicalRoot)) {
    const absolute = path.resolve(canonicalRoot, relative);
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`C5 artifact escaped root: ${relative}`);
    const metadata = await lstat(absolute);
    const bytes = await readFile(absolute);
    // UTF-8 and Latin-1 views catch text in JSON/logs and common PDF metadata.
    assertCleanText(bytes.toString("utf8"), relative);
    assertCleanText(bytes.toString("latin1"), relative);
    entries.push({
      path: relative,
      sizeBytes: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const receipt = {
    schemaVersion: 1,
    artifactKind: "gate-c-c5-artifact-privacy-scan",
    sourceSha,
    entries,
    treeSha256: createHash("sha256").update(canonicalJson(entries)).digest("hex"),
  };
  return {
    ...receipt,
    receiptSha256: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
  };
}

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error("Expected --name value arguments");
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

async function main() {
  const values = args(process.argv.slice(2));
  const root = values.get("root");
  const sourceSha = values.get("source-sha");
  if (!root || !sourceSha) throw new Error("--root and --source-sha are required");
  const receipt = await scanGateCC5Artifacts(root, sourceSha);
  const output = values.get("output");
  if (output) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
