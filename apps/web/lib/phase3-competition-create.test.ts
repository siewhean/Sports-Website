import { describe, expect, it } from "vitest";
import {
  competitionCreateFieldOrder,
  firstInvalidCompetitionCreateField,
  isCompetitionCreateRequest,
  parseCompetitionCreateReceipt,
  parseCompetitionOrganisationBootstrapReceipt,
  parseCompetitionOrganisationOptions,
  phase3CompetitionSports,
  type CompetitionCreateDraft,
} from "./phase3-competition-create";

const validDraft: CompetitionCreateDraft = {
  organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
  name: "National Open",
  slug: "national-open",
  sport_code: "badminton",
  venue: "National Hall",
  address: "1 Arena Road",
  locality: "Singapore",
  country_code: "SG",
  starts_on: "2027-05-01",
  ends_on: "2027-05-02",
  timezone: "Asia/Singapore",
  locale: "en-SG",
};
const validCommand = { ...validDraft, idempotency_key: "competition-create-0001" };

describe("competition creation contract", () => {
  it("accepts every supported sport without substituting Canoe Polo", () => {
    expect(phase3CompetitionSports.map(({ code }) => code)).toEqual([
      "canoe_polo",
      "badminton",
      "table_tennis",
      "volleyball",
      "basketball",
    ]);
    for (const { code } of phase3CompetitionSports) {
      expect(isCompetitionCreateRequest({ ...validCommand, sport_code: code })).toBe(true);
      expect(
        parseCompetitionCreateReceipt({
          id: "4dc85811-e715-40f4-8609-2523f7516e5a",
          status: "draft",
          sport_code: code,
          revision: 1,
          account_default_applied: false,
        })?.sport_code,
      ).toBe(code);
    }
  });

  it("rejects missing, unsupported and additional fields", () => {
    expect(isCompetitionCreateRequest({ ...validCommand, sport_code: "" })).toBe(false);
    expect(isCompetitionCreateRequest({ ...validCommand, sport_code: "football" })).toBe(false);
    expect(isCompetitionCreateRequest({ ...validCommand, extra: true })).toBe(false);
    expect(isCompetitionCreateRequest(validDraft)).toBe(false);
  });

  it("identifies the first invalid field in rendered form order", () => {
    expect(firstInvalidCompetitionCreateField({ ...validDraft, name: "", sport_code: "" })).toBe("name");
    expect(competitionCreateFieldOrder.indexOf("name")).toBeLessThan(competitionCreateFieldOrder.indexOf("sport_code"));
  });

  it("rejects an inverted date range and malformed receipt", () => {
    expect(isCompetitionCreateRequest({ ...validCommand, ends_on: "2027-04-30" })).toBe(false);
    expect(isCompetitionCreateRequest({ ...validCommand, starts_on: "2027-02-30" })).toBe(false);
    expect(isCompetitionCreateRequest({ ...validCommand, timezone: "Mars/Olympus" })).toBe(false);
    expect(isCompetitionCreateRequest({ ...validCommand, locale: "" })).toBe(false);
    expect(
      parseCompetitionCreateReceipt({
        id: "4dc85811-e715-40f4-8609-2523f7516e5a",
        status: "draft",
        sport_code: "football",
        revision: 1,
        account_default_applied: false,
      }),
    ).toBeNull();
  });

  it("accepts only unique writable organisation options", () => {
    const owner = { id: validDraft.organisation_id, name: "National Sports", role: "owner" };
    expect(parseCompetitionOrganisationOptions([owner])).toEqual([owner]);
    expect(parseCompetitionOrganisationOptions([{ ...owner, role: "viewer" }])).toBeNull();
    expect(parseCompetitionOrganisationOptions([owner, owner])).toBeNull();
  });

  it("accepts only exact first-workspace bootstrap receipts", () => {
    const receipt = {
      id: validDraft.organisation_id,
      name: "Organiser workspace",
      role: "owner",
      created: true,
    };
    expect(parseCompetitionOrganisationBootstrapReceipt(receipt)).toEqual(receipt);
    expect(parseCompetitionOrganisationBootstrapReceipt({ ...receipt, role: "viewer" })).toBeNull();
    expect(parseCompetitionOrganisationBootstrapReceipt({ ...receipt, token: "must-not-be-accepted" })).toBeNull();
    expect(parseCompetitionOrganisationBootstrapReceipt({ ...receipt, created: "true" })).toBeNull();
  });
});
