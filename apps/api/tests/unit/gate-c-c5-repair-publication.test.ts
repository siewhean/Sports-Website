import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateCC5RepairPublicationExecutor } from "../../src/gate-c-c5-repair-publication.js";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  fetchMock.mockReset();
  target.verifyPublication.mockClear();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const target = {
  apiOrigin: "http://127.0.0.1:4101",
  webOrigin: "http://localhost:3103",
  competitionId: "competition",
  slug: "competition",
  correctionTransactionId: "correction",
  organiserCookie: "session=opaque",
  verifyPublication: vi.fn(async () => undefined),
};
const invocation = {
  operation: "repair_publication" as const,
  workerIndex: 0,
  sampleIndex: 0,
  signal: new AbortController().signal,
};

describe("C5 repair-publication executor", () => {
  it("uses server versions and parent fingerprint to publish one repair", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(
        json({
          repair: { repair_id: "repair" },
          latest_revision: { repair_revision_id: "parent", analysis_fingerprint: "a".repeat(64) },
          current_result_version: 3,
          published_schedule_version: 2,
          actions: [{ match_id: "match", slot: "home", source_action: "protected_started_match" }],
        }),
      )
      .mockResolvedValueOnce(
        json({ revision: { repair_revision_id: "revision", analysis_fingerprint: "a".repeat(64) } }, 201),
      )
      .mockResolvedValueOnce(
        json({
          duplicate: false,
          competition_id: "competition",
          repair_id: "repair",
          repair_revision_id: "revision",
          schedule_revision_id: "schedule-revision",
          schedule_version: 3,
          result_version: 4,
          projection_version: 5,
          analysis_fingerprint: "a".repeat(64),
          published_at: "2026-08-10T08:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        json({
          freshness: {
            schedule_version: 3,
            result_version: 4,
            projection_version: 5,
            division_projection_versions: { division: 5 },
          },
        }),
      );
    const executor = createGateCC5RepairPublicationExecutor([target]);

    await expect(executor(invocation)).resolves.toEqual({ outcome: "success", correctness: { passed: true } });
    const revision = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(revision).toMatchObject({
      parent_revision_id: "parent",
      expected_result_version: 3,
      expected_schedule_version: 2,
      expected_analysis_fingerprint: "a".repeat(64),
      status: "ready",
    });
    expect(revision.decisions).toMatchObject([{ decision: "keep_current" }]);
    expect(target.verifyPublication).toHaveBeenCalledWith({
      competitionId: "competition",
      repairId: "repair",
      repairRevisionId: "revision",
      scheduleRevisionId: "schedule-revision",
      scheduleVersion: 3,
      resultVersion: 4,
      projectionVersion: 5,
      analysisFingerprint: "a".repeat(64),
    });
  });

  it("fails when canonical public readback does not match the atomic publication receipt", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrf_token: "csrf" }))
      .mockResolvedValueOnce(
        json({
          repair: { repair_id: "repair" },
          latest_revision: { repair_revision_id: "parent", analysis_fingerprint: "a".repeat(64) },
          current_result_version: 3,
          published_schedule_version: 2,
          actions: [],
        }),
      )
      .mockResolvedValueOnce(
        json({ revision: { repair_revision_id: "revision", analysis_fingerprint: "a".repeat(64) } }, 201),
      )
      .mockResolvedValueOnce(
        json({
          duplicate: false,
          competition_id: "competition",
          repair_id: "repair",
          repair_revision_id: "revision",
          schedule_revision_id: "schedule-revision",
          schedule_version: 3,
          result_version: 4,
          projection_version: 5,
          analysis_fingerprint: "a".repeat(64),
          published_at: "2026-08-10T08:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        json({
          freshness: {
            schedule_version: 3,
            result_version: 3,
            projection_version: 5,
            division_projection_versions: { division: 5 },
          },
        }),
      );
    const executor = createGateCC5RepairPublicationExecutor([target]);
    await expect(executor(invocation)).resolves.toMatchObject({
      correctness: { failureCode: "repair_publication_projection_http_200" },
    });
  });

  it("fails closed when no fresh target remains", async () => {
    const executor = createGateCC5RepairPublicationExecutor([target]);
    await expect(executor({ ...invocation, sampleIndex: 1 })).resolves.toMatchObject({
      correctness: { failureCode: "repair_publication_target_exhausted" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
