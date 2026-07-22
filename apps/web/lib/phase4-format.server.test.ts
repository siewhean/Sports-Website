import { describe, expect, it } from "vitest";
import { getFormatBuilderDocument } from "./phase4-format.server";

describe("format builder sport authority", () => {
  it.each(["", "football"])("fails closed for unsupported sport %j", async (sportCode) => {
    await expect(
      getFormatBuilderDocument({
        competitionId: "competition-1",
        competitionName: "Competition",
        divisionId: "division-1",
        divisionName: "Open",
        sportCode,
      }),
    ).resolves.toMatchObject({ state: "error", sportCode });
  });
});
