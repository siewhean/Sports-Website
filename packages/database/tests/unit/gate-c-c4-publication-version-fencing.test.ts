import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations/0040_gate_c_repair_publication_version_fencing.sql",
);

describe("Gate C C4 repair publication version fencing migration", () => {
  it("binds the projection to the receipt revision and exact public versions", async () => {
    const source = await readFile(migrationPath, "utf8");

    expect(source).toContain("projection.source_repair_revision_id IS DISTINCT FROM receipt.repair_revision_id");
    expect(source).toContain("projection.schedule_version<>receipt.schedule_version");
    expect(source).toContain("projection.result_version<>receipt.result_version");
    expect(source).toContain("repair publication projection versions must match the receipt");
    expect(source).toContain("schedule_repair_publication_projection_version_guard");
  });

  it("remains safe in staged historical upgrade fixtures", async () => {
    const source = await readFile(migrationPath, "utf8");

    expect(source).toContain("to_regclass('schedule_repair_publication_receipts') IS NULL");
    expect(source).toContain("to_regclass('public_projection_versions') IS NULL");
    expect(source).toContain("to_regclass('schedule_repair_publication_projection_versions') IS NULL");
    expect(source).toContain("RETURN;");
  });
});
