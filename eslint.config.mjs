import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/**", "**/node_modules/**"]),
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.ts"] })),
]);
