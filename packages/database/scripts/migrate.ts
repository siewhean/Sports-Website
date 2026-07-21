import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { migrateDatabase } from "../src/migrations.js";

const config = parseConfig(process.env);
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const result = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory });
console.log(`Database migrations current: ${result.current.join(", ")}. Applied now: ${result.applied.length}.`);
