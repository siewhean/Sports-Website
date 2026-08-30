import { describe, expect, it, vi } from "vitest";
import { CompetitionRepository } from "../../src/repositories/competition.repository.js";
import type { SqlExecutor } from "../../src/repositories/types.js";

describe("organiser competition library repository", () => {
  it("lists only active owner/organiser memberships and normalises timestamps", async () => {
    const unsafe = vi.fn().mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        organisation_id: "22222222-2222-4222-8222-222222222222",
        organisation_name: "Harbour Sports Club",
        membership_role: "organiser",
        name: "Harbour Open",
        slug: "harbour-open",
        sport_code: "canoe_polo",
        status: "draft",
        starts_on: "2026-09-10",
        ends_on: "2026-09-11",
        timezone: "Asia/Singapore",
        updated_at: new Date("2026-08-31T04:00:00.000Z"),
        published: false,
      },
    ]);
    const repository = new CompetitionRepository({ unsafe } as unknown as SqlExecutor);

    const result = await repository.listByAccountId("33333333-3333-4333-8333-333333333333");

    expect(result).toEqual([
      expect.objectContaining({
        name: "Harbour Open",
        membership_role: "organiser",
        updated_at: "2026-08-31T04:00:00.000Z",
        published: false,
      }),
    ]);
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = unsafe.mock.calls[0]!;
    expect(query).toContain("membership.status = 'active'");
    expect(query).toContain("membership.role IN ('owner', 'organiser')");
    expect(query).toContain("LEFT JOIN competition_publications");
    expect(params).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });
});
