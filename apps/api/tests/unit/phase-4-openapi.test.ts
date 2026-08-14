import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../scripts/openapi.js";

type Operation = {
  security?: unknown;
  parameters?: Array<{ name: string }>;
  requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
  responses?: Record<string, unknown>;
};

describe("Phase 4 OpenAPI contract", () => {
  it("publishes the authenticated setup, format, AI, and scheduling surfaces with guarded strict mutations", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    const requiredPaths = [
      "/api/v1/competitions/{competitionId}/setup-draft",
      "/api/v1/competitions/{competitionId}/setup-draft/resume",
      "/api/v1/competitions/{competitionId}/v1-format-recommendations",
      "/api/v1/competitions/{competitionId}/v1-format-recommendations/{recommendationId}/apply",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/format-builder",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/format-builder/validate",
      "/api/v1/organisations/{organisationId}/format-templates",
      "/api/v1/organisations/{organisationId}/ai/competition-brief",
      "/api/v1/competitions/{competitionId}/schedule-workspace",
      "/api/v1/competitions/{competitionId}/schedule-jobs",
      "/api/v1/schedule-jobs/{jobId}/options/{optionId}/accept",
      "/api/v1/schedule-revisions/{revisionId}/moves/validate",
      "/api/v1/schedule-revisions/{revisionId}/locks",
      "/api/v1/schedule-revisions/{revisionId}/publish",
    ];
    expect(requiredPaths.every((path) => document.paths[path])).toBe(true);

    const setupPath = requiredPaths[0]!;
    const resumePath = requiredPaths[1]!;
    const mutations = [
      document.paths[setupPath]?.put,
      document.paths[setupPath]?.patch,
      document.paths[resumePath]?.post,
      document.paths[requiredPaths[2]!]?.post,
      document.paths[requiredPaths[3]!]?.post,
      document.paths[requiredPaths[4]!]?.put,
      document.paths[requiredPaths[7]!]?.post,
      document.paths[requiredPaths[9]!]?.post,
      document.paths[requiredPaths[10]!]?.post,
      document.paths[requiredPaths[12]!]?.post,
      document.paths[requiredPaths[13]!]?.post,
    ];
    for (const mutation of mutations) {
      expect(mutation?.security).toEqual([{ sessionCookie: [] }]);
      expect(mutation?.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining(["origin", "x-csrf-token"]),
      );
      expect(mutation?.requestBody?.content?.["application/json"]?.schema?.additionalProperties).toBe(false);
      expect(mutation?.responses).toHaveProperty("409");
      expect(mutation?.responses).toHaveProperty("422");
    }
  });

  it("expresses strict nested setup and schedule-constraint objects", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    const setupPath = "/api/v1/competitions/{competitionId}/setup-draft";
    const setup = document.paths[setupPath]?.put?.requestBody?.content?.["application/json"]?.schema as
      { properties?: { transition?: { anyOf?: Array<Record<string, unknown>> } } } | undefined;
    const transitions = setup?.properties?.transition?.anyOf ?? [];
    expect(transitions).toHaveLength(3);
    expect(transitions.every((transition) => transition.additionalProperties === false)).toBe(true);

    const patch = document.paths[setupPath]?.patch?.requestBody?.content?.["application/json"]?.schema as
      { additionalProperties?: boolean; properties?: Record<string, unknown> } | undefined;
    expect(patch?.additionalProperties).toBe(false);
    expect(Object.keys(patch?.properties ?? {}).sort()).toEqual(["expected_revision", "idempotency_key", "step"]);

    const job = document.paths["/api/v1/competitions/{competitionId}/schedule-jobs"]?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema as
      | { properties?: { constraints?: { additionalProperties?: boolean; properties?: Record<string, unknown> } } }
      | undefined;
    expect(job?.properties?.constraints?.additionalProperties).toBe(false);
    expect(Object.keys(job?.properties?.constraints?.properties ?? {})).toHaveLength(11);
  });
});
