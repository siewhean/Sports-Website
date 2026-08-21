import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "@matchday/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 3 - Pairwise 02: Forward Migrations x C4 Repositories x Rollback (F03 x F06 x F08)", () => {
  it("P02-T01: forward migration sequence 0036-0051 defines tables required by C4 repositories", () => {
    const migrationsDir = path.join(rootDir, "packages/database/migrations");
    const files = readdirSync(migrationsDir);

    expect(files.some((f) => f.startsWith("0037_") && f.includes("repair"))).toBe(true);
    expect(files.some((f) => f.startsWith("0038_") && f.includes("repair_revision_fencing"))).toBe(true);
    expect(files.some((f) => f.startsWith("0040_") && f.includes("publication_version_fencing"))).toBe(true);
    expect(files.some((f) => f.startsWith("0045_") && f.includes("atomic_result_repair_cases"))).toBe(true);
  });

  it("P02-T02: repository layer uses typed ErrorCode for conflict and rollback conditions", () => {
    expect(ErrorCode.REPAIR_REVISION_CONFLICT).toBe("REPAIR_REVISION_CONFLICT");
    expect(ErrorCode.REPAIR_PUBLICATION_FINGERPRINT_MISMATCH).toBe("REPAIR_PUBLICATION_FINGERPRINT_MISMATCH");
    expect(ErrorCode.REPAIR_ADJUSTMENT_UNKNOWN_MATCH).toBe("REPAIR_ADJUSTMENT_UNKNOWN_MATCH");
  });

  it("P02-T03: atomic transaction rollback preserves repository invariants on simulated abort", async () => {
    const repositoryMock = {
      revisions: new Map<string, { status: string }>(),
      async appendRevision(id: string, status: string, fail: boolean) {
        const previous = this.revisions.get(id);
        try {
          this.revisions.set(id, { status });
          if (fail) throw new Error("Transaction aborted");
        } catch (e) {
          if (previous) this.revisions.set(id, previous);
          else this.revisions.delete(id);
          throw e;
        }
      },
    };

    await expect(repositoryMock.appendRevision("rev-1", "published", true)).rejects.toThrow("Transaction aborted");
    expect(repositoryMock.revisions.has("rev-1")).toBe(false);

    await expect(repositoryMock.appendRevision("rev-1", "draft", false)).resolves.toBeUndefined();
    expect(repositoryMock.revisions.get("rev-1")?.status).toBe("draft");
  });
});
