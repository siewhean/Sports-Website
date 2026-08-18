import { describe, expect, it } from "vitest";
import {
  competitionSetupResumeHref,
  competitionSetupResumeStorageKey,
  parseCompetitionSetupResume,
  serializeCompetitionSetupResume,
} from "./competition-setup-resume";

describe("competition setup resume pointer", () => {
  it("round trips only the competition identity needed to return to setup", () => {
    const raw = serializeCompetitionSetupResume({
      competitionId: "4dc85811-e715-40f4-8609-2523f7516e5a",
      competitionName: "National Open",
    });

    expect(parseCompetitionSetupResume(raw)).toEqual({
      competitionId: "4dc85811-e715-40f4-8609-2523f7516e5a",
      competitionName: "National Open",
    });
    expect(raw).not.toContain("entries");
    expect(raw).not.toContain("settings");
  });

  it("keeps resume pointers isolated by signed-in account", () => {
    expect(competitionSetupResumeStorageKey("account-a")).not.toBe(
      competitionSetupResumeStorageKey("account-b"),
    );
    expect(competitionSetupResumeStorageKey("account/a")).toContain("account%2Fa");
  });

  it("rejects malformed or unsafe stored routes", () => {
    expect(parseCompetitionSetupResume(null)).toBeNull();
    expect(parseCompetitionSetupResume("not-json")).toBeNull();
    expect(
      parseCompetitionSetupResume(
        JSON.stringify({
          version: 1,
          competitionId: "../sign-in",
          competitionName: "Injected",
        }),
      ),
    ).toBeNull();
    expect(
      parseCompetitionSetupResume(
        JSON.stringify({
          version: 2,
          competitionId: "competition-1",
          competitionName: "Old schema",
        }),
      ),
    ).toBeNull();
  });

  it("builds the canonical organiser setup route", () => {
    expect(
      competitionSetupResumeHref({
        competitionId: "competition-1",
        competitionName: "National Open",
      }),
    ).toBe("/organiser/competitions/competition-1/setup");
  });
});
