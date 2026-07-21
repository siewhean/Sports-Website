import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDirectory = path.join(root, "apps/web/.next");
const staticDirectory = path.join(nextDirectory, "static");
const outputPath = path.join(root, "artifacts/deployment-manifest.json");

const buildId = (await readFile(path.join(nextDirectory, "BUILD_ID"), "utf8")).trim();
if (buildId.length === 0) throw new Error("Next.js BUILD_ID is empty; run pnpm build first");

const relativeFiles = await walk(staticDirectory);
if (relativeFiles.length === 0) throw new Error("No Next.js static assets found; run pnpm build first");

const assets = await Promise.all(
  relativeFiles.sort().map(async (relativePath) => {
    const contents = await readFile(path.join(staticDirectory, relativePath));
    return {
      path: `/_next/static/${relativePath.split(path.sep).join("/")}`,
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }),
);

const manifest = {
  schemaVersion: 1,
  buildId,
  assetCount: assets.length,
  assets,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${assets.length} assets for build ${buildId} to ${path.relative(root, outputPath)}`);

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path.join(directory, entry.name), relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}
