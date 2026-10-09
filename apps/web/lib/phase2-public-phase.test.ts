import { describe, expect, it } from "vitest";
import { dayNumberInTimezone, publicCompetitionPhase } from "./phase2-public-phase";

const sg = "Asia/Singapore";
// 19-20 Sept 2026 event, as in production.
const event = { startsOn: "2026-09-19", endsOn: "2026-09-20", timezone: sg } as const;

describe("publicCompetitionPhase", () => {
  it("labels a published event upcoming before and during its dates when nothing is live", () => {
    expect(publicCompetitionPhase({ status: "published", ...event }, new Date("2026-09-01T00:00:00Z"))).toBe(
      "upcoming",
    );
    expect(publicCompetitionPhase({ status: "active", ...event }, new Date("2026-09-19T20:00:00+08:00"))).toBe(
      "upcoming",
    );
  });

  it("labels the same event completed once October arrives, whatever the stale status says", () => {
    const october = new Date("2026-10-09T09:00:00Z");
    expect(publicCompetitionPhase({ status: "active", ...event }, october)).toBe("completed");
    expect(publicCompetitionPhase({ status: "published", ...event }, october)).toBe("completed");
    expect(publicCompetitionPhase({ status: "live", ...event }, october)).toBe("completed");
    expect(publicCompetitionPhase({ status: "live", hasLiveMatch: true, ...event }, october)).toBe("completed");
  });

  it("treats live status or a live match as live while the event is on", () => {
    const during = new Date("2026-09-20T10:00:00+08:00");
    expect(publicCompetitionPhase({ status: "live", ...event }, during)).toBe("live");
    expect(publicCompetitionPhase({ status: "active", hasLiveMatch: true, ...event }, during)).toBe("live");
  });

  it("always treats completed and archived as completed", () => {
    const early = new Date("2026-09-01T00:00:00Z");
    expect(publicCompetitionPhase({ status: "completed", ...event }, early)).toBe("completed");
    expect(publicCompetitionPhase({ status: "archived" }, early)).toBe("completed");
    expect(publicCompetitionPhase({ status: "completed", hasLiveMatch: true, ...event }, early)).toBe("completed");
  });

  it("uses the competition timezone for the day boundary", () => {
    // 20 Sept 23:30 in Singapore is still 20 Sept 15:30Z; 00:30 on 21 Sept in Singapore is 16:30Z on the 20th.
    const lastEvening = new Date("2026-09-20T23:30:00+08:00");
    const justAfterMidnight = new Date("2026-09-21T00:30:00+08:00");
    expect(dayNumberInTimezone(lastEvening, sg)).not.toBe(dayNumberInTimezone(justAfterMidnight, sg));
    // Grace day: a match running past midnight on the final day keeps the event live, but an idle event is done.
    expect(publicCompetitionPhase({ status: "live", ...event }, justAfterMidnight)).toBe("live");
    expect(publicCompetitionPhase({ status: "published", ...event }, justAfterMidnight)).toBe("completed");
    // The same instant read in UTC would still be 20 Sept, so a UTC-only comparison would disagree.
    expect(publicCompetitionPhase({ status: "published", ...event, timezone: "UTC" }, justAfterMidnight)).toBe(
      "upcoming",
    );
    // Two days after the end the event is completed even if the server never moved it on from live.
    expect(publicCompetitionPhase({ status: "live", ...event }, new Date("2026-09-22T09:00:00+08:00"))).toBe(
      "completed",
    );
  });

  it("falls back to status alone when dates are missing or malformed", () => {
    const now = new Date("2026-10-09T09:00:00Z");
    expect(publicCompetitionPhase({ status: "published" }, now)).toBe("upcoming");
    expect(publicCompetitionPhase({ status: "live" }, now)).toBe("live");
    expect(publicCompetitionPhase({ status: "active", endsOn: "not-a-date", timezone: sg }, now)).toBe("upcoming");
  });

  it("survives an invalid timezone by falling back to UTC", () => {
    expect(
      publicCompetitionPhase(
        { status: "active", endsOn: "2026-09-20", timezone: "Not/AZone" },
        new Date("2026-10-09T09:00:00Z"),
      ),
    ).toBe("completed");
  });
});
