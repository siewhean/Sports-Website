import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\n  async ", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("live match public projection invariants", () => {
  it("keeps the per-point path off the competition publication row and the full projection rebuild", async () => {
    const source = await readFile(new URL("../../src/phase-2-runtime.ts", import.meta.url), "utf8");
    const append = methodBody(source, "  async appendCanonicalScoreEvent(");

    // A point writes one row keyed by its match; courts never serialise on the competition.
    expect(append).toContain("await this.writeLiveScore(tx, session.match_id, sequence, reduced, serverReceivedAt)");
    expect(append).not.toContain("FROM competition_publications");
    expect(append).not.toContain("writePublicProjection");
    expect(append).not.toContain("console.debug");
    // The outbox keeps one coalesced row per match instead of one per point.
    expect(append).toContain("`scoring_event.appended:match:${session.match_id}`");
    expect(append).toContain("ON CONFLICT (idempotency_key) DO UPDATE");

    expect(source).toContain("INSERT INTO public_live_match_scores");
    expect(source).toContain("WHERE public_live_match_scores.aggregate_version <= EXCLUDED.aggregate_version");
    // Full rebuilds still render live matches, record the stale cut-off, and never consume result versions.
    expect(source).toContain("JOIN match_score_streams stream ON stream.match_id=m.id");
    expect(source).toContain("WHERE m.competition_id=$1 AND m.state='in_progress'");
    expect(source).toContain('state: "in_progress"');
    expect(source).toContain("live_overlay_cutoff_at=EXCLUDED.live_overlay_cutoff_at");
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

  it("only overlays live rows for matches still in progress and newer than the projection's stale cut-off", async () => {
    const overlay = await readFile(new URL("../../src/public-live-overlay.ts", import.meta.url), "utf8");
    expect(overlay).toContain("live_match.state='in_progress'");
    expect(overlay).toContain("live.updated_at > ${projection}.live_overlay_cutoff_at");
    expect(overlay).toContain("${publication}.schedule_version > 0");
  });
});
