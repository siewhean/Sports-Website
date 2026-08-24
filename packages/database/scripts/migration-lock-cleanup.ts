export type C2CleanupOutcome = {
  schemaDropped: boolean;
  temporaryMigrationDirectoryRemoved: boolean;
  failures: string[];
};

/** Executes both disposable-resource teardowns even when either one fails. */
export async function cleanupC2MigrationLockResources(
  dropSchema: () => Promise<void>,
  removeTemporaryMigrationDirectory: () => Promise<void>,
): Promise<C2CleanupOutcome> {
  const [schema, directory] = await Promise.allSettled([dropSchema(), removeTemporaryMigrationDirectory()]);
  const failures = [schema, directory]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
  return {
    schemaDropped: schema.status === "fulfilled",
    temporaryMigrationDirectoryRemoved: directory.status === "fulfilled",
    failures,
  };
}
