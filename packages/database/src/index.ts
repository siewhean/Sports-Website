import postgres from "postgres";
export { accountFactory, membershipFactory, organisationFactory } from "./factories.js";
export { dropTestSchema, migrateDatabase, migrationAdvisoryLockId } from "./migrations.js";

export async function probeDatabase(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, { connect_timeout: 2, max: 1 });
  try {
    const result = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
    return result[0]?.ok === 1;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
