import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../scripts/openapi.js";

describe("Phase 3 OpenAPI contract", () => {
  it("publishes authenticated Phase 3 subresources and mutation guard headers", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            security?: unknown;
            parameters?: Array<{ name: string }>;
            requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
            responses?: Record<string, unknown>;
          }
        >
      >;
    };
    const paths = [
      "/api/v1/competitions/phase3",
      "/api/v1/competitions/{competitionId}/phase3",
      "/api/v1/competitions/{competitionId}/lifecycle/archive",
      "/api/v1/competitions/{competitionId}/lifecycle/transition",
      "/api/v1/competitions/{competitionId}/duplicate",
      "/api/v1/competitions/{competitionId}/divisions",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/entries",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/entries/{entryId}",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/entries/{entryId}/lifecycle",
      "/api/v1/competitions/{competitionId}/settings",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/settings",
      "/api/v1/competitions/{competitionId}/settings/copy-previous",
      "/api/v1/account/sport-defaults/{sportCode}",
      "/api/v1/admin/sport-packs/drafts",
      "/api/v1/admin/sport-packs/{sportCode}",
      "/api/v1/admin/sport-packs/{sportCode}/{version}",
      "/api/v1/admin/sport-packs/{sportCode}/{version}/activate",
      "/api/v1/competitions/{competitionId}/capacity",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/entries/import",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/format-revisions",
      "/api/v1/competitions/{competitionId}/format-revisions/{formatId}/publish",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/standings/recalculate",
      "/api/v1/competitions/{competitionId}/divisions/{divisionId}/standings",
    ];
    expect(paths.every((path) => document.paths[path])).toBe(true);
    expect(document.paths[paths[1] ?? ""]?.get?.security).toEqual([{ sessionCookie: [] }]);
    const settingsMutation = document.paths["/api/v1/competitions/{competitionId}/settings"]?.put;
    expect(settingsMutation?.security).toEqual([{ sessionCookie: [] }]);
    expect(settingsMutation?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(["origin", "x-csrf-token"]),
    );
    const formatMutation =
      document.paths["/api/v1/competitions/{competitionId}/divisions/{divisionId}/format-revisions"]?.post;
    const bodySchema = formatMutation?.requestBody?.content?.["application/json"]?.schema as
      { properties?: { definition?: { properties?: Record<string, unknown>; required?: string[] } } } | undefined;
    expect(bodySchema?.properties?.definition?.required).toEqual(
      expect.arrayContaining(["id", "schemaVersion", "entryCount", "stages", "matches", "terminalMatchIds"]),
    );
    expect(bodySchema?.properties?.definition?.properties?.stages).toBeDefined();
    expect(bodySchema?.properties?.definition?.properties?.matches).toBeDefined();
    expect(formatMutation?.responses).toHaveProperty("400");
    expect(formatMutation?.responses).toHaveProperty("422");
    expect(
      document.paths["/api/v1/competitions/{competitionId}/format-revisions/{formatId}/publish"]?.post?.responses,
    ).toHaveProperty("422");
    const capacityMutation = document.paths["/api/v1/competitions/{competitionId}/capacity"]?.put;
    const capacityBody = capacityMutation?.requestBody?.content?.["application/json"]?.schema as
      { required?: string[] } | undefined;
    expect(capacityBody?.required).toEqual(expect.arrayContaining(["revision", "areas"]));
    expect(capacityMutation?.responses).toHaveProperty("409");
    const adminDraft = document.paths["/api/v1/admin/sport-packs/drafts"]?.post;
    expect(adminDraft?.security).toEqual([{ sessionCookie: [] }]);
    expect(adminDraft?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(["origin", "x-csrf-token"]),
    );
    expect(
      document.paths["/api/v1/competitions/{competitionId}/divisions/{divisionId}/standings-snapshots"],
    ).toBeUndefined();
    expect(
      document.paths["/api/v1/competitions/{competitionId}/divisions/{divisionId}/standings/recalculate"]?.post
        ?.requestBody,
    ).toBeUndefined();
  });
});
