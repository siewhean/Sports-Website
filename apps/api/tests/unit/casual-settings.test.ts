import { describe, expect, it } from "vitest";
import { normalizeCasualSettings } from "../../src/casual-routes.js";

describe("casual game settings", () => {
  it("uses the selected sport pack and only accepts applicable settings", () => {
    const timed = normalizeCasualSettings({ sport_id: "basketball", home_name: " Home ", away_name: "Away" });
    expect(timed.home_name).toBe("Home");
    expect(timed.period_minutes).toBeGreaterThan(0);
    expect(timed.target_points).toBeUndefined();
    const sets = normalizeCasualSettings({ sport_id: "badminton", home_name: "A", away_name: "B", best_of_sets: 3 });
    expect(sets.best_of_sets).toBe(3);
    expect(sets.target_points).toBeGreaterThan(0);
    expect(() =>
      normalizeCasualSettings({ sport_id: "badminton", home_name: "A", away_name: "B", period_minutes: 10 }),
    ).toThrow();
    expect(() =>
      normalizeCasualSettings({ sport_id: "basketball", home_name: "A", away_name: "B", best_of_sets: 3 }),
    ).toThrow();
  });
});
