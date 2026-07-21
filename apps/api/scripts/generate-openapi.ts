import { writeFile } from "node:fs/promises";
import { generateOpenApiDocument } from "./openapi.js";

const target = new URL("../openapi.generated.json", import.meta.url);
await writeFile(target, await generateOpenApiDocument(), "utf8");
console.log("Generated apps/api/openapi.generated.json");
