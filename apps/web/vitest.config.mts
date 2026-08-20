import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: root },
      {
        find: "server-only",
        replacement: fileURLToPath(new URL("./tests/unit/server-only-stub.ts", import.meta.url)),
      },
    ],
  },
  test: {
    env: {
      MATCHDAY_PUBLIC_ORIGIN: "https://matchday.test",
    },
  },
});
