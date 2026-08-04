import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../scripts/openapi.js";

type Operation = {
  security?: readonly Record<string, readonly unknown[]>[];
  parameters?: readonly { name?: string; in?: string; required?: boolean }[];
  requestBody?: {
    content?: { "application/json"?: { schema?: { required?: string[]; additionalProperties?: boolean } } };
  };
  responses?: Record<string, unknown>;
};

function headerNames(operation: Operation): string[] {
  return (operation.parameters ?? [])
    .filter((parameter) => parameter.in === "header")
    .map((parameter) => parameter.name ?? "");
}

function jsonBody(operation: Operation) {
  return operation.requestBody?.content?.["application/json"]?.schema;
}

describe("Gate C C4 OpenAPI acceptance contract", () => {
  it("exposes the complete authenticated repair and fallback export surface", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    const mutations = [
      ["/api/v1/competitions/{competitionId}/repairs/analyse", "post"],
      ["/api/v1/competitions/{competitionId}/repairs/{repairId}/revisions", "post"],
      ["/api/v1/competitions/{competitionId}/repairs/{repairId}/revisions/{revisionId}/publish", "post"],
      ["/api/v1/competitions/{competitionId}/repairs/{repairId}/abandon", "post"],
      ["/api/v1/competitions/{competitionId}/exports/schedule", "post"],
      ["/api/v1/competitions/{competitionId}/exports/matches/{matchId}/score-sheet", "post"],
    ] as const;
    const reads = [
      ["/api/v1/competitions/{competitionId}/repairs", "get"],
      ["/api/v1/competitions/{competitionId}/repairs/pending", "get"],
      ["/api/v1/competitions/{competitionId}/repairs/{repairId}", "get"],
    ] as const;

    for (const [path, method] of [...reads, ...mutations]) {
      expect(document.paths[path]?.[method]).toBeDefined();
      expect(document.paths[path]?.[method]?.security).toEqual([{ sessionCookie: [] }]);
    }
    for (const [path, method] of mutations) {
      expect(headerNames(document.paths[path]![method]!)).toEqual(expect.arrayContaining(["origin", "x-csrf-token"]));
    }

    const analyse = jsonBody(document.paths[mutations[0][0]]!.post!);
    expect(analyse?.required).toEqual(["correction_transaction_id"]);
    expect(analyse?.additionalProperties).toBe(false);

    const revision = jsonBody(document.paths[mutations[1][0]]!.post!);
    expect(revision?.required).toEqual(
      expect.arrayContaining([
        "parent_revision_id",
        "expected_result_version",
        "expected_schedule_version",
        "expected_analysis_fingerprint",
        "status",
        "decisions",
        "schedule_adjustments",
      ]),
    );
    expect(revision?.additionalProperties).toBe(false);

    const publication = jsonBody(document.paths[mutations[2][0]]!.post!);
    expect(publication?.required).toEqual(
      expect.arrayContaining([
        "competition_id",
        "repair_id",
        "repair_revision_id",
        "expected_schedule_version",
        "expected_result_version",
        "expected_analysis_fingerprint",
        "publication_idempotency_key",
      ]),
    );
    expect(publication?.additionalProperties).toBe(false);
  });

  it("publishes one unauthenticated version-matched public truth route with conditional reads", async () => {
    const document = JSON.parse(await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    const operation = document.paths["/api/v1/public/competitions/{slug}/current"]?.get;

    expect(operation).toBeDefined();
    expect(operation).not.toHaveProperty("security");
    expect(headerNames(operation!)).toEqual(expect.arrayContaining(["if-none-match", "if-modified-since"]));
    expect(operation?.responses).toHaveProperty("200");
    expect(operation?.responses).toHaveProperty("304");
    expect(operation?.responses).toHaveProperty("404");
  });
});
