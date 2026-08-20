import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedOutputs = [
  "apps/api/dist",
  "apps/scheduler/dist",
  "apps/web/.next",
  "apps/worker/dist",
  "packages/config/dist",
  "packages/contracts/dist",
  "packages/database/dist",
  "packages/domain/dist",
  "packages/edge-cache/dist",
  "packages/feature-flags/dist",
  "packages/identity/dist",
  "packages/jobs/dist",
  "packages/notifications/dist",
  "packages/observability/dist",
  "packages/ui/dist",
];

const present = [];
for (const relativePath of generatedOutputs) {
  try {
    await access(path.join(root, relativePath));
    present.push(relativePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (present.length > 0) {
  throw new Error(`Clean checkout contains generated outputs: ${present.join(", ")}`);
}

console.log(`Clean-checkout guard passed (${generatedOutputs.length} generated output paths absent)`);
