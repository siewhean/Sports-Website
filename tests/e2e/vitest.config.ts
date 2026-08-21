import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@matchday/contracts": path.resolve(rootDir, "packages/contracts/src/index.ts"),
      "@matchday/domain": path.resolve(rootDir, "packages/domain/src/index.ts"),
      "@matchday/config": path.resolve(rootDir, "packages/config/src/index.ts"),
      "@matchday/identity": path.resolve(rootDir, "packages/identity/src/index.ts"),
      "@matchday/observability": path.resolve(rootDir, "packages/observability/src/index.ts"),
      "@matchday/feature-flags": path.resolve(rootDir, "packages/feature-flags/src/index.ts"),
      "@matchday/database": path.resolve(rootDir, "packages/database/src/index.ts"),
      "fake-indexeddb": path.resolve(rootDir, "apps/web/node_modules/fake-indexeddb/build/esm/index.js"),
    },
  },
});
