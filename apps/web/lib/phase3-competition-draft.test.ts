import { describe, expect, it } from "vitest";
import type { CompetitionCreateDraft } from "./phase3-competition-create";
import {
  competitionCreateDraftStorageKey,
  parseCompetitionCreateDraft,
  serializeCompetitionCreateDraft,
} from "./phase3-competition-draft";

const incompleteDraft: CompetitionCreateDraft = {
  organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
  name: "National Open",
  slug: "national-open",
  sport_code: "",
  venue: "",
  address: "",
  locality: "",
  country_code: "SG",
  starts_on: "",
  ends_on: "",
  timezone: "Asia/Singapore",
  locale: "en-SG",
};

describe("competition creation draft persistence", () => {
  it("round trips an intentionally incomplete competition draft", () => {
    expect(parseCompetitionCreateDraft(serializeCompetitionCreateDraft(incompleteDraft))).toEqual(incompleteDraft);
  });

  it("scopes the storage key to the signed-in account", () => {
    expect(competitionCreateDraftStorageKey("account-a")).not.toBe(competitionCreateDraftStorageKey("account-b"));
    expect(competitionCreateDraftStorageKey("account/a")).toContain("account%2Fa");
  });

  it("rejects malformed, unversioned, additional and oversized stored data", () => {
    expect(parseCompetitionCreateDraft("not-json")).toBeNull();
    expect(parseCompetitionCreateDraft(JSON.stringify({ draft: incompleteDraft }))).toBeNull();
    expect(
      parseCompetitionCreateDraft(
        JSON.stringify({ version: 1, draft: { ...incompleteDraft, unexpected: "do not restore" } }),
      ),
    ).toBeNull();
    expect(
      parseCompetitionCreateDraft(
        JSON.stringify({ version: 1, draft: { ...incompleteDraft, address: "x".repeat(16_385) } }),
      ),
    ).toBeNull();
  });
});
