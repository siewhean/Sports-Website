import { describe, expect, it, vi } from "vitest";
import { cleanupC2MigrationLockResources } from "../../scripts/migration-lock-cleanup.js";

describe("Gate C C2 disposable migration-lock cleanup", () => {
  it("attempts both cleanup operations and retains the exact failure", async () => {
    const dropSchema = vi.fn().mockRejectedValueOnce(new Error("schema drop denied"));
    const removeDirectory = vi.fn().mockResolvedValueOnce(undefined);

    await expect(cleanupC2MigrationLockResources(dropSchema, removeDirectory)).resolves.toEqual({
      schemaDropped: false,
      temporaryMigrationDirectoryRemoved: true,
      failures: ["schema drop denied"],
    });
    expect(dropSchema).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });
});
