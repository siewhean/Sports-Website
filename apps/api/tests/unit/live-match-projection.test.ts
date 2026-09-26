import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("live match public projection invariants", () => {
  it("serializes live projection rebuilds without consuming final-result versions", async () => {
    const source = await readFile(new URL("../../src/phase-2-runtime.ts", import.meta.url), "utf8");

    expect(source).toContain("FROM competition_publications");
    expect(source).toContain("WHERE competition_id=$1\n             FOR UPDATE");
    expect(source).toContain("SET updated_at=$2");
    expect(source).toContain("publication.schedule_version,\n            publication.result_version");
    expect(source).toContain("JOIN match_score_streams stream ON stream.match_id=m.id");
    expect(source).toContain("WHERE m.competition_id=$1 AND m.state='in_progress'");
    expect(source).toContain('state: "in_progress"');
    expect(source).not.toContain("const nextResultVersion = publication.result_version + 1");
    expect(source).not.toContain("VALUES ($1,$2,$3,$4,$5,'in_progress',$6::jsonb)");
  });

  it("keeps live snapshots out of standings, brackets, withdrawals, repairs, and provenance", async () => {
    const [phase2, phase3, repair] = await Promise.all([
      readFile(new URL("../../src/phase-2-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/phase-3-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/repositories/repair.repository.ts", import.meta.url), "utf8"),
    ]);

    expect(phase2).toContain("snapshot.state IN ('final','corrected')");
    expect(phase2).toContain("s.state IN ('final','corrected')");
    expect(phase3.match(/s\.state IN \('final','corrected'\)/gu)).toHaveLength(2);
    expect(repair).toContain("snapshot.state IN ('final','corrected')");
  });
});
