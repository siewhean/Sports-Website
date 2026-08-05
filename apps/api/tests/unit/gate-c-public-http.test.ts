import { describe, expect, it } from "vitest";
import type { PublicProjectionFreshness } from "@matchday/contracts";
import {
  gateCC4PublicCacheControl,
  gateCC4PublicConditionalStatus,
  gateCC4PublicHeaders,
} from "../../src/gate-c-public-http.js";

function freshness(overrides: Partial<PublicProjectionFreshness> = {}): PublicProjectionFreshness {
  return {
    division_id: "division-1",
    schedule_version: 4,
    result_version: 7,
    projection_version: 9,
    generated_at: "2026-08-01T00:00:05.000Z",
    source_updated_at: "2026-08-01T00:00:00.000Z",
    etag: "projection-9",
    ...overrides,
  };
}

describe("Gate C C4 public projection HTTP freshness", () => {
  it("emits bounded revalidation and explicit public versions", () => {
    expect(gateCC4PublicHeaders(freshness())).toEqual({
      etag: '"projection-9"',
      "last-modified": "Sat, 01 Aug 2026 00:00:00 GMT",
      "cache-control": gateCC4PublicCacheControl,
      "x-matchday-schedule-version": "4",
      "x-matchday-result-version": "7",
      "x-matchday-projection-version": "9",
    });
    expect(gateCC4PublicCacheControl).toBe("public, max-age=0, s-maxage=15, must-revalidate");
  });

  it("returns 304 for matching strong or weak ETags", () => {
    expect(gateCC4PublicConditionalStatus(freshness(), { "if-none-match": '"projection-9"' })).toBe(304);
    expect(gateCC4PublicConditionalStatus(freshness(), { "If-None-Match": 'W/"projection-9"' })).toBe(304);
    expect(gateCC4PublicConditionalStatus(freshness(), { "if-none-match": '"old", "projection-9"' })).toBe(304);
    expect(gateCC4PublicConditionalStatus(freshness(), { "if-none-match": "*" })).toBe(304);
  });

  it("gives ETag conditions precedence over If-Modified-Since", () => {
    expect(
      gateCC4PublicConditionalStatus(freshness(), {
        "if-none-match": '"old"',
        "if-modified-since": "Sun, 02 Aug 2026 00:00:00 GMT",
      }),
    ).toBe(200);
  });

  it("uses source update time for valid date-based conditional requests", () => {
    expect(
      gateCC4PublicConditionalStatus(freshness(), {
        "if-modified-since": "Sat, 01 Aug 2026 00:00:00 GMT",
      }),
    ).toBe(304);
    expect(
      gateCC4PublicConditionalStatus(freshness(), {
        "if-modified-since": "Fri, 31 Jul 2026 23:59:59 GMT",
      }),
    ).toBe(200);
  });

  it("rejects impossible or malformed freshness metadata", () => {
    expect(() => gateCC4PublicHeaders(freshness({ schedule_version: -1 }))).toThrow(/non-negative/);
    expect(() => gateCC4PublicHeaders(freshness({ result_version: -1 }))).toThrow(/non-negative/);
    expect(() => gateCC4PublicHeaders(freshness({ projection_version: 0 }))).toThrow(/positive/);
    expect(() =>
      gateCC4PublicHeaders(
        freshness({ generated_at: "2026-07-31T23:59:59.000Z", source_updated_at: "2026-08-01T00:00:00.000Z" }),
      ),
    ).toThrow(/before its source update/);
    expect(() => gateCC4PublicHeaders(freshness({ etag: "bad\nheader" }))).toThrow(/ETag/);
  });
});
