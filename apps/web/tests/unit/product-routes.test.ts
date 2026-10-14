import { describe, expect, it } from "vitest";
import { GET as getProductCompetitions, POST as postProductCompetitions } from "../../app/api/competitions/route";
import { GET as getPhase3Competitions, POST as postPhase3Competitions } from "../../app/api/phase3/competitions/route";
import { POST as postProductBootstrap } from "../../app/api/organisations/bootstrap/route";
import { POST as postPhase3Bootstrap } from "../../app/api/phase3/organisations/bootstrap/route";

describe("product route re-exports and aliases", () => {
  it("exports identical handlers for /api/competitions and /api/phase3/competitions", () => {
    expect(getProductCompetitions).toBe(getPhase3Competitions);
    expect(postProductCompetitions).toBe(postPhase3Competitions);
  });

  it("exports identical handlers for /api/organisations/bootstrap and /api/phase3/organisations/bootstrap", () => {
    expect(postProductBootstrap).toBe(postPhase3Bootstrap);
  });
});
