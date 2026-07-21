import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_migration_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

try {
  const first = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  const second = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
  if (first.applied.length === 0 || second.applied.length !== 0) {
    throw new Error("Migration idempotency check failed");
  }
  console.log(`Clean-schema migration check passed with ${first.current.length} migration(s).`);
} finally {
  await dropTestSchema(config.databaseUrl, schema);
}
