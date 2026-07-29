import { describe, expect, it } from "vitest";
import {
  assertPublicProjectionPrivacy,
  canonicalPublicProjectionVersionInput,
  publicProjectionPrivacyViolations,
} from "../src/index.js";

describe("Gate C C4 public truth guards", () => {
  it("produces deterministic freshness input independent of property ordering and timestamp offsets", () => {
    const first = canonicalPublicProjectionVersionInput({
      competitionId: "competition-1",
      scheduleVersion: 4,
      resultVersion: 7,
      projectionVersion: 9,
      generatedAt: "2026-07-29T12:30:00.000Z",
      sourceUpdatedAt: "2026-07-29T20:29:00.000+08:00",
    });
    const second = canonicalPublicProjectionVersionInput({
      projectionVersion: 9,
      competitionId: "competition-1",
      sourceUpdatedAt: "2026-07-29T12:29:00.000Z",
      generatedAt: "2026-07-29T20:30:00.000+08:00",
      resultVersion: 7,
      scheduleVersion: 4,
    });

    expect(second).toBe(first);
    expect(first).toBe(
      '{"competition_id":"competition-1","generated_at":"2026-07-29T12:30:00.000Z","projection_version":9,"result_version":7,"schedule_version":4,"source_updated_at":"2026-07-29T12:29:00.000Z"}',
    );
  });

  it("rejects invalid versions and projections generated before their source update", () => {
    expect(() =>
      canonicalPublicProjectionVersionInput({
        competitionId: "competition-1",
        scheduleVersion: 0,
        resultVersion: 1,
        projectionVersion: 1,
        generatedAt: "2026-07-29T12:30:00.000Z",
        sourceUpdatedAt: "2026-07-29T12:29:00.000Z",
      }),
    ).toThrow(/Schedule version/);

    expect(() =>
      canonicalPublicProjectionVersionInput({
        competitionId: "competition-1",
        scheduleVersion: 1,
        resultVersion: 1,
        projectionVersion: 1,
        generatedAt: "2026-07-29T12:28:00.000Z",
        sourceUpdatedAt: "2026-07-29T12:29:00.000Z",
      }),
    ).toThrow(/before its source update/);
  });

  it("allows public competition, division, schedule, result, standings and freshness fields", () => {
    const projection = {
      competition: {
        id: "competition-1",
        name: "Singapore Open",
        slug: "singapore-open",
        sport_code: "canoe_polo",
      },
      divisions: [
        {
          division: { id: "division-open", name: "Open" },
          schedule: [
            {
              id: "match-1",
              code: "M1",
              home: { id: "team-a", name: "Team A" },
              away: { id: "team-b", name: "Team B" },
              starts_at: "2026-08-01T01:00:00.000Z",
              area: { id: "court-1", name: "Court 1" },
            },
          ],
          results: [],
          standings: { rows: [] },
          bracket: null,
        },
      ],
      publication: { schedule_version: 4, result_version: 7, projection_version: 9 },
      last_updated_at: "2026-07-29T12:30:00.000Z",
    };

    expect(publicProjectionPrivacyViolations(projection)).toEqual([]);
    expect(() => assertPublicProjectionPrivacy(projection)).not.toThrow();
  });

  it("rejects private identity, session, credential and contact fields anywhere in the projection", () => {
    const projection = {
      competition: { id: "competition-1", name: "Singapore Open" },
      divisions: [
        {
          division: { id: "division-open", name: "Open" },
          internal: {
            account_id: "account-1",
            scoring_session_id: "session-1",
            device_label: "Official iPhone",
            email: "official@example.test",
          },
        },
      ],
    };

    expect(publicProjectionPrivacyViolations(projection)).toEqual([
      { path: "divisions.0.internal.account_id", reason: "forbidden_field" },
      { path: "divisions.0.internal.device_label", reason: "forbidden_field" },
      { path: "divisions.0.internal.email", reason: "forbidden_field" },
      { path: "divisions.0.internal.scoring_session_id", reason: "forbidden_field" },
    ]);
    expect(() => assertPublicProjectionPrivacy(projection)).toThrow(/forbidden data/);
  });

  it("rejects secret-like material even when placed under an otherwise public field", () => {
    expect(
      publicProjectionPrivacyViolations({
        public_notice: "Open https://matchday.test/score#access=secret-value",
        result_note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      }),
    ).toEqual([
      { path: "public_notice", reason: "secret_like_value" },
      { path: "result_note", reason: "secret_like_value" },
    ]);
  });

  it("rejects cycles, functions and non-finite numeric values rather than silently serialising them", () => {
    const cyclic: Record<string, unknown> = { value: "safe" };
    cyclic.self = cyclic;
    const projection = { cyclic, function_value: () => undefined, score: Number.NaN };

    expect(publicProjectionPrivacyViolations(projection)).toEqual([
      { path: "cyclic.self", reason: "unsupported_value" },
      { path: "function_value", reason: "unsupported_value" },
      { path: "score", reason: "unsupported_value" },
    ]);
  });
});
