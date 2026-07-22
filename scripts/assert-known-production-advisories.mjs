#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const lockfile = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

function versionsFor(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s{2}'?${escaped}@([^':\\s]+)'?:`, "gm");
  return [...lockfile.matchAll(pattern)].map((match) => match[1]);
}

function compare(left, right) {
  const parts = (value) => value.split(".").map((part) => Number(part.replace(/[^0-9].*$/u, "")) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function assertMinimum(packageName, minimum, advisory) {
  const versions = versionsFor(packageName);
  if (versions.length === 0) throw new Error(`${packageName} is missing from the lockfile`);
  const vulnerable = versions.filter((version) => compare(version, minimum) < 0);
  if (vulnerable.length > 0) {
    throw new Error(`${advisory}: ${packageName} ${vulnerable.join(", ")} is below patched version ${minimum}`);
  }
  process.stdout.write(`${packageName}: ${versions.join(", ")} satisfies ${advisory} (>=${minimum})\n`);
}

assertMinimum("fast-uri", "3.1.2", "GHSA-v39h-62p7-jpjc");
assertMinimum("fast-uri", "3.1.1", "GHSA-q3j6-qgpj-74h6");
assertMinimum("sharp", "0.32.6", "GHSA-54xq-cgqr-rpm3");
assertMinimum("sharp", "0.30.5", "GHSA-gp95-ppv5-3jc5");

const libvipsPackages = [
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-libvips-linux-arm",
  "@img/sharp-libvips-linux-ppc64",
  "@img/sharp-libvips-linux-riscv64",
  "@img/sharp-libvips-linux-s390x",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-libvips-linuxmusl-arm64",
  "@img/sharp-libvips-linuxmusl-x64",
];
for (const packageName of libvipsPackages) {
  if (versionsFor(packageName).length === 0) throw new Error(`${packageName} optional binary is missing from the lockfile`);
}
process.stdout.write("Sharp/libvips optional platform coverage is present.\n");
