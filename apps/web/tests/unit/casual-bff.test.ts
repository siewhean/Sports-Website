import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardCasualRequest } from "@/lib/casual-bff.server";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RENDER_API_ORIGIN", "");
  vi.stubEnv("MATCHDAY_API_BASE_URL", "http://127.0.0.1:4000");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe("casual API forwarding", () => {
  it("starts a guest game using the configured local API without a Render rewrite", async () => {
    const body = JSON.stringify({ sport_id: "badminton", home_name: "A", away_name: "B" });
    fetchMock.mockResolvedValue(
      Response.json({ game: { id: "game-1" }, host_token: "host", viewer_token: "viewer" }, { status: 201 }),
    );
    const response = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ host_token: "host", viewer_token: "viewer" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4000/api/v1/casual/games"),
      expect.objectContaining({ method: "POST", body }),
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves viewing credentials and host credentials for scoring", async () => {
    fetchMock.mockResolvedValue(Response.json({ home_score: 1 }));
    await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games/game-1?viewer_token=view"));
    expect(fetchMock.mock.calls[0]?.[0].href).toBe(
      "http://127.0.0.1:4000/api/v1/casual/games/game-1?viewer_token=view",
    );
    await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1/actions", {
        method: "POST",
        headers: { "x-casual-host-token": "secret-host", "content-type": "application/json" },
        body: '{"side":"home"}',
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1].headers.get("x-casual-host-token")).toBe("secret-host");
  });

  it("reports unavailable backend configuration and missing create routes clearly", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "Route not found" }, { status: 404 }));
    const response = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: expect.stringContaining("temporarily unavailable") });
    vi.stubEnv("MATCHDAY_API_BASE_URL", "");
    expect((await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games"))).status).toBe(503);
  });

  it("preserves missing-game errors rather than turning them into service errors", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: "Casual game not found" } }, { status: 404 }));
    expect((await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games/unknown"))).status).toBe(
      404,
    );
  });
});
