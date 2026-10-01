import { afterEach, expect, it, vi } from "vitest";
import { createCasualGame } from "@/lib/casual-client";

afterEach(() => vi.unstubAllGlobals());

it("shows the API validation message when game creation fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: "VALIDATION_ERROR", message: "Team names must differ" } }, { status: 400 }),
      ),
  );
  await expect(createCasualGame({ sport_id: "badminton", home_name: "Same", away_name: "Same" })).rejects.toThrow(
    "Team names must differ",
  );
});
