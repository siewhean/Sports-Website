import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { consoleMigrationLogger, migrateDatabase } from "../src/migrations.js";

const config = parseConfig(process.env);
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const result = await migrateDatabase({
  databaseUrl: config.databaseUrl,
  migrationsDirectory,
  logger: consoleMigrationLogger,
  lockTimeoutMs: config.migrations.lockTimeoutMs,
  statementTimeoutMs: config.migrations.statementTimeoutMs,
  lockRetries: config.migrations.lockRetries,
});
console.log(`Database migrations current: ${result.current.join(", ")}. Applied now: ${result.applied.length}.`);
