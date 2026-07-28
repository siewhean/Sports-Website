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
      "/api/v1/competitions/{competitionId}/matches/{matchId}/reopen",
      "/api/v1/competitions/{competitionId}/matches/{matchId}/corrections",
      "/api/v1/competitions/{competitionId}/matches/{matchId}/scoring-audit",
      "/api/v1/competitions/{competitionId}/result-conflicts",
      "/api/v1/competitions/{competitionId}/result-conflicts/{conflictId}/acknowledge",
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
    const scoringEvent = document.paths["/api/v1/scoring/events"]?.post as {
      requestBody?: {
        content?: {
          "application/json"?: {
            schema?: { required?: string[]; properties?: Record<string, unknown> };
          };
        };
      };
    };
    const scoringEventSchema = scoringEvent.requestBody?.content?.["application/json"]?.schema;
    expect(scoringEventSchema?.required).toEqual(
      expect.arrayContaining(["client_event_id", "expected_sequence", "type", "occurred_at"]),
    );
    expect(scoringEventSchema?.properties).not.toHaveProperty("home_score");
    expect(scoringEventSchema?.properties).not.toHaveProperty("payload");
    const scoringFinalisation = document.paths["/api/v1/scoring/finalise"]?.post as {
      responses?: {
        "200"?: {
          content?: {
            "application/json"?: {
              schema?: {
                required?: string[];
                properties?: Record<string, unknown>;
                additionalProperties?: boolean;
              };
            };
          };
        };
      };
    };
    const scoringFinalisationSchema = scoringFinalisation.responses?.["200"]?.content?.["application/json"]?.schema;
    const scoringFinalisationReceiptKeys = [
      "match_id",
      "sequence",
      "aggregate_version",
      "duplicate",
      "home_score",
      "away_score",
      "result_version",
    ];
    expect(scoringFinalisationSchema?.required).toEqual(scoringFinalisationReceiptKeys);
    expect(Object.keys(scoringFinalisationSchema?.properties ?? {})).toEqual(scoringFinalisationReceiptKeys);
    expect(scoringFinalisationSchema?.additionalProperties).toBe(false);
    const correction = document.paths["/api/v1/competitions/{competitionId}/matches/{matchId}/corrections"]?.post as {
      requestBody?: {
        content?: { "application/json"?: { schema?: { required?: string[]; properties?: Record<string, unknown> } } };
      };
    };
    const correctionSchema = correction.requestBody?.content?.["application/json"]?.schema;
    expect(correctionSchema?.required).toEqual(
      expect.arrayContaining(["client_event_id", "reason", "expected_aggregate_version", "events"]),
    );
    expect(correctionSchema?.properties).not.toHaveProperty("home_score");
    expect(correctionSchema?.properties).not.toHaveProperty("away_score");
    for (const route of [
      "/api/v1/competitions/{competitionId}/matches/{matchId}/reopen",
      "/api/v1/competitions/{competitionId}/matches/{matchId}/corrections",
    ]) {
      const response = document.paths[route]?.post as {
        responses?: {
          "200"?: {
            content?: {
              "application/json"?: { schema?: { required?: string[]; additionalProperties?: boolean } };
            };
          };
        };
      };
      const schema = response.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(schema?.required).toEqual(
        expect.arrayContaining([
          "match_id",
          "aggregate_version",
          "through_sequence",
          "duplicate",
          "result_version",
          "publication_version",
          "conflicts",
        ]),
      );
      expect(schema?.additionalProperties).toBe(false);
    }
    const acknowledgement = document.paths[
      "/api/v1/competitions/{competitionId}/result-conflicts/{conflictId}/acknowledge"
    ]?.post as {
      requestBody?: {
        content?: { "application/json"?: { schema?: { required?: string[] } } };
      };
    };
    expect(acknowledgement.requestBody?.content?.["application/json"]?.schema?.required).toEqual(
      expect.arrayContaining(["client_event_id", "reason", "expected_revision"]),
    );
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
        "divisions",
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
    expect(publicSchema?.properties).toHaveProperty("divisions");
  });
});
