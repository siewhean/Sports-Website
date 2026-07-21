import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([globalIgnores(["dist/**", "openapi.generated.json"]), ...tseslint.configs.recommended]);
