import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseTakeoverDecision, parseTakeoverRequests } from "../../lib/gate-c-access";

const requestId = "00000000-0000-4000-8000-000000000201";
const matchId = "00000000-0000-4000-8000-000000000202";
const conflictId = "00000000-0000-4000-8000-000000000203";

function pendingRequest(extra: Record<string, unknown> = {}) {
  return {
    id: requestId,
    match_id: matchId,
    status: "pending",
    requester_pending_event_count: 2,
    incumbent_pending_state: "unknown",
    requested_at: "2030-01-01T00:00:00.000Z",
    requesting_device_label: "Tablet scorer",
    incumbent_device_label: "Phone scorer",
    requesting_session_id: "must-not-cross-the-bff",
    incumbent_session_id: "must-not-cross-the-bff",
    ...extra,
  };
}

describe("Gate C organiser takeover parsing", () => {
  it("allowlists the organiser review fields and omits session identifiers", () => {
    const requests = parseTakeoverRequests([pendingRequest()]);

    expect(requests).toEqual([
      {
        id: requestId,
        matchId,
        status: "pending",
        requesterPendingEventCount: 2,
        incumbentPendingState: "unknown",
        requestedAt: "2030-01-01T00:00:00.000Z",
        requestingDeviceLabel: "Tablet scorer",
        incumbentDeviceLabel: "Phone scorer",
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("session");
  });

  it("rejects malformed pending-state and decision envelopes", () => {
    expect(parseTakeoverRequests([pendingRequest({ incumbent_pending_state: "clear" })])).toBeNull();
    expect(parseTakeoverRequests([pendingRequest({ requester_pending_event_count: -1 })])).toBeNull();
    expect(parseTakeoverDecision({ id: requestId, status: "approved", generation: 0 })).toBeNull();
    expect(parseTakeoverDecision({ id: requestId, status: "denied" })).toEqual({ id: requestId, status: "denied" });
  });

  it("accepts an approved conflict receipt without exposing credentials", () => {
    expect(
      parseTakeoverDecision({
        id: requestId,
        status: "approved",
        generation: 6,
        lease_expires_at: "2030-01-01T00:00:45.000Z",
        conflict_id: conflictId,
        session_token: "must-not-be-projected",
      }),
    ).toEqual({
      id: requestId,
      status: "approved",
      generation: 6,
      leaseExpiresAt: "2030-01-01T00:00:45.000Z",
      conflictId,
    });
  });
});

describe("Gate C access source guards", () => {
  it("requires acknowledgement and a reason before approving an uncertain transfer", async () => {
    const source = await readFile(new URL("../../components/phase5/AccessPassManager.tsx", import.meta.url), "utf8");

    expect(source).toContain("reviewing.incumbentPendingState !== gateCAccessMachine.none");
    expect(source).toContain("!overrideAcknowledged");
    expect(source).toContain("decisionReason.trim().length < 3");
    expect(source).toContain("takeoverReturnTarget.current?.focus()");
  });

  it("reveals a rotated one-time code and keeps inactive passes out of mutation actions", async () => {
    const source = await readFile(new URL("../../components/phase5/AccessPassManager.tsx", import.meta.url), "utf8");

    const rotation = source.indexOf("const rotate = async");
    const reveal = source.indexOf("revealDialog.current?.showModal()", rotation);
    expect(source.indexOf("shortCode: result.shortCode", rotation)).toBeGreaterThan(rotation);
    expect(reveal).toBeGreaterThan(rotation);
    expect(source).toContain("const inactive = pass.status !== gateCAccessMachine.active");
    expect(source).toContain("disabled={!canEdit || inactive}");
  });

  it("renames the IndexedDB identity without fingerprinting and restores edit focus", async () => {
    const deviceSource = await readFile(new URL("../../lib/scoring-device.ts", import.meta.url), "utf8");
    const scoringSource = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");

    expect(deviceSource).toContain("id: current?.id ?? crypto.randomUUID()");
    expect(deviceSource).toContain("indexedDB.open");
    expect(deviceSource).not.toMatch(/canvas|audioContext|hardwareConcurrency|deviceMemory/i);
    expect(scoringSource).toContain("await renameScoringDevice(deviceLabelDraft)");
    expect(scoringSource).toContain("editDeviceButtonRef.current?.focus()");
    expect(scoringSource).toContain('setAnnouncement(t("prototype.d9ff75e574c6"))');
  });
});
