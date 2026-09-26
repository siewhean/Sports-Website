import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("live match public projection invariants", () => {
  it("serializes competition-wide live result versions and refreshes public truth atomically", async () => {
    const source = await readFile(new URL("../../src/phase-2-runtime.ts", import.meta.url), "utf8");

    expect(source).toContain("FROM competition_publications");
    expect(source).toContain("WHERE competition_id=$1\n             FOR UPDATE");
    expect(source).toContain("const nextResultVersion = publication.result_version + 1");
    expect(source).toContain("VALUES ($1,$2,$3,$4,$5,'in_progress',$6::jsonb)");
    expect(source).toContain("SET result_version=$2,updated_at=$3");
    expect(source).toContain("publication.schedule_version,\n            nextResultVersion");
  });

  it("keeps live snapshots out of standings, brackets, withdrawals, repairs, and provenance", async () => {
    const [phase2, phase3, repair, migration] = await Promise.all([
      readFile(new URL("../../src/phase-2-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/phase-3-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/repositories/repair.repository.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../../../packages/database/migrations/0057_live_result_snapshot_provenance.sql", import.meta.url),
        "utf8",
      ),
    ]);

    expect(phase2).toContain("snapshot.state IN ('final','corrected')");
    expect(phase2).toContain("s.state IN ('final','corrected')");
    expect(phase3.match(/s\.state IN \('final','corrected'\)/gu)).toHaveLength(2);
    expect(repair).toContain("snapshot.state IN ('final','corrected')");
    expect(migration).toContain("AND s.state IN ('final','corrected')");
  });
});
