import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../scripts/openapi.js";

describe("Phase 2 OpenAPI contract", () => {
  it("publishes the complete organiser, scoring, recovery, audit, and public route surface", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const requiredPaths = [
      "/api/v1/competitions",
      "/api/v1/competitions/{competitionId}",
      "/api/v1/competitions/{competitionId}/canoe-polo-settings",
      "/api/v1/competitions/{competitionId}/divisions",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/entries",
      "/api/v1/competitions/{competitionId}/capacity",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/format-revisions/generate",
      "/api/v1/competitions/{competitionId}/schedule-revisions/generate",
      "/api/v1/competitions/{competitionId}/schedule-revisions/{revisionId}/publish",
      "/api/v1/competitions/{competitionId}/matches/{matchId}/access-passes",
      "/api/v1/scoring/access/exchange",
      "/api/v1/scoring/session",
      "/api/v1/scoring/sessions/transfer",
      "/api/v1/scoring/events",
      "/api/v1/scoring/finalise",
      "/api/v1/competitions/{competitionId}/matches/{matchId}/corrections",
      "/api/v1/competitions/{competitionId}/audit",
      "/api/v1/public/competitions/{slug}",
    ];
    expect(requiredPaths.every((path) => document.paths[path])).toBe(true);

    const exchange = document.paths["/api/v1/scoring/access/exchange"]?.post as {
      parameters?: readonly { name: string; in: string }[];
      requestBody?: { content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } } };
    };
    expect(exchange.parameters?.some((parameter) => parameter.name === "token")).not.toBe(true);
    expect(exchange.requestBody?.content?.["application/json"]?.schema?.properties).toHaveProperty("token");

    for (const route of ["/api/v1/scoring/session", "/api/v1/scoring/events", "/api/v1/scoring/finalise"]) {
      const method = route === "/api/v1/scoring/session" ? "get" : "post";
      expect(document.paths[route]?.[method]).toMatchObject({ security: [{ scoringSession: [] }] });
    }
    const scoringSessionOperation = document.paths["/api/v1/scoring/session"]?.get as {
      responses?: {
        "200"?: {
          content?: {
            "application/json"?: {
              schema?: {
                required?: string[];
                properties?: Record<string, { properties?: Record<string, { pattern?: string }> }>;
              };
            };
          };
        };
      };
    };
    const scoringSessionSchema = scoringSessionOperation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(scoringSessionSchema?.required).toEqual(expect.arrayContaining(["competition", "match", "writer"]));
    expect(scoringSessionSchema?.properties?.competition?.properties?.slug?.pattern).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(document.paths["/api/v1/competitions/{competitionId}"]?.get).toMatchObject({
      security: [{ sessionCookie: [] }],
    });
    const publicOperation = document.paths["/api/v1/public/competitions/{slug}"]?.get as {
      security?: unknown;
      responses?: {
        "200"?: {
          content?: { "application/json"?: { schema?: { required?: string[]; properties?: Record<string, unknown> } } };
        };
      };
    };
    expect(publicOperation).not.toHaveProperty("security");
    const publicSchema = publicOperation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(publicSchema?.required).toEqual(
      expect.arrayContaining([
        "competition",
        "division",
        "publication",
        "schedule",
        "results",
        "standings",
        "bracket",
        "last_updated_at",
      ]),
    );
    expect(publicSchema?.properties).toHaveProperty("schedule");
    expect(publicSchema?.properties).toHaveProperty("results");
  });
});
