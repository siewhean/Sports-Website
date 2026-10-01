import { expect, it } from "vitest";
import { generateOpenApiDocument } from "../../scripts/openapi.js";

it("includes guest, host and account casual operations without executing persistence", async () => {
  const document = JSON.parse(await generateOpenApiDocument());
  expect(document.paths["/api/v1/casual/games"].post).toBeDefined();
  for (const action of ["actions", "undo", "timer", "finish", "claim", "share"]) {
    expect(document.paths[`/api/v1/casual/games/{id}/${action}`].post).toBeDefined();
  }
  expect(document.paths["/api/v1/casual/games/{id}"].get).toBeDefined();
  expect(document.paths["/api/v1/casual/friends/shared-games"].get).toBeDefined();
});

it("documents the actual anonymous, capability and session/CSRF alternatives", async () => {
  const document = JSON.parse(await generateOpenApiDocument());
  const paths = document.paths;
  const schemes = document.components.securitySchemes;
  expect(paths["/api/v1/casual/games"].post.security).toEqual([]);
  expect(paths["/api/v1/casual/games/{id}"].get.security).toEqual([
    { casualHost: [] },
    { casualViewerHeader: [] },
    { casualViewerQuery: [] },
    { sessionCookie: [] },
  ]);
  for (const action of ["actions", "undo", "timer", "finish"]) {
    expect(paths[`/api/v1/casual/games/{id}/${action}`].post.security).toEqual([{ casualHost: [] }]);
  }
  expect(paths["/api/v1/casual/games/{id}/claim"].post.security).toEqual([
    { sessionCookie: [], csrfToken: [], casualHost: [] },
  ]);
  for (const path of [
    "/api/v1/casual/me/presets",
    "/api/v1/casual/friends/requests",
    "/api/v1/casual/friends/requests/{id}/accept",
    "/api/v1/casual/games/{id}/share",
  ]) {
    expect(paths[path].post.security).toEqual([{ sessionCookie: [], csrfToken: [] }]);
  }
  for (const path of [
    "/api/v1/casual/me/games",
    "/api/v1/casual/me/presets",
    "/api/v1/casual/friends",
    "/api/v1/casual/friends/requests",
    "/api/v1/casual/friends/shared-games",
  ]) {
    expect(paths[path].get.security).toEqual([{ sessionCookie: [] }]);
  }
  expect(schemes.casualHost).toMatchObject({ type: "apiKey", in: "header", name: "x-casual-host-token" });
  expect(schemes.casualViewerHeader).toMatchObject({ type: "apiKey", in: "header", name: "x-casual-viewer-token" });
  expect(schemes.casualViewerQuery).toMatchObject({ type: "apiKey", in: "query", name: "viewer_token" });
  expect(schemes.csrfToken).toMatchObject({ type: "apiKey", in: "header", name: "x-csrf-token" });
});
