import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as createEntry } from "../../app/api/phase3/competitions/[competitionId]/divisions/[divisionId]/entries/route";
import { POST as createDivision } from "../../app/api/phase3/competitions/[competitionId]/divisions/route";
import { POST as planEntries } from "../../app/api/phase3/competitions/[competitionId]/divisions/[divisionId]/entries/plan/route";
import { PATCH as updateEntry } from "../../app/api/phase3/competitions/[competitionId]/divisions/[divisionId]/entries/[entryId]/route";

const origin = "https://matchday.test";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";
const divisionId = "36d57835-7557-46b8-b945-733934027efc";
const idempotencyKey = "00000000-0000-4000-8000-000000000001";

function request(path: string, body: Record<string, unknown>, requestOrigin = origin, method = "POST") {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: "matchday_session=valid-session",
      host: "matchday.test",
      origin: requestOrigin,
    },
    body: JSON.stringify(body),
  });
}

function identity() {
  return Response.json({
    account: {
      id: "account-a",
      primary_email: "organiser@example.test",
      display_name: "Organiser",
      email_verified_at: null,
    },
    csrf_token: "csrf-token-at-least-16-characters",
    idle_expires_at: "2027-05-01T02:00:00.000Z",
    absolute_expires_at: "2027-05-01T08:00:00.000Z",
  });
}

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MATCHDAY_API_BASE_URL;
});

describe("division and entry BFF", () => {
  it("creates a second division through the authenticated CSRF boundary", async () => {
    const body = { name: "Women", code: "WOMEN", entry_limit: 16, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identity();
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/divisions`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        origin,
        "x-csrf-token": "csrf-token-at-least-16-characters",
      });
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json({ id: divisionId, competition_id: competitionId, name: "Women", team_limit: 16 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createDivision(request(`/api/phase3/competitions/${competitionId}/divisions`, body), {
      params: Promise.resolve({ competitionId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: divisionId, name: "Women" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards the validated public origin behind an HTTPS-terminating proxy", async () => {
    const body = { name: "Women", code: "WOMEN", entry_limit: 16, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      expect(new Headers(init?.headers).get("origin")).toBe(origin);
      return Response.json({ id: divisionId, competition_id: competitionId, name: "Women", team_limit: 16 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const proxied = new NextRequest(`http://127.0.0.1:3103/api/phase3/competitions/${competitionId}/divisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "matchday_session=valid-session",
        host: "matchday.test",
        origin,
        "x-forwarded-host": "matchday.test",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify(body),
    });

    const response = await createDivision(proxied, { params: Promise.resolve({ competitionId }) });

    expect(response.status).toBe(200);
  });

  it("creates an entry and preserves a free-plan rejection from the API", async () => {
    const body = { name: "Harbour", entry_type: "team", seed: 9, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      return Response.json(
        {
          error: {
            code: "PLAN_LIMIT",
            message: "Free plan permits at most 16 active entries",
            request_id: "request-17",
          },
        },
        { status: 422 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createEntry(
      request(`/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries`, body),
      { params: Promise.resolve({ competitionId, divisionId }) },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "PLAN_LIMIT" } });
  });

  it("returns the authoritative entry created by the API", async () => {
    const body = { name: "Harbour", entry_type: "team", seed: 9, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identity();
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries`);
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json({
        id: "77df44ed-d7c0-4721-8577-8098285c5591",
        division_id: divisionId,
        name: "Harbour",
        entry_type: "team",
        seed: 9,
        status: "active",
        revision: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createEntry(
      request(`/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries`, body),
      { params: Promise.resolve({ competitionId, divisionId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Harbour", seed: 9, status: "active" });
  });

  it("rejects malformed and cross-origin mutations before an upstream write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const malformed = await createEntry(
      request(`/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries`, {
        name: "Harbour",
        seed: 49,
      }),
      { params: Promise.resolve({ competitionId, divisionId }) },
    );
    const crossOrigin = await createDivision(
      request(
        `/api/phase3/competitions/${competitionId}/divisions`,
        { name: "Open", entry_limit: 16, idempotency_key: idempotencyKey },
        "https://attacker.test",
      ),
      { params: Promise.resolve({ competitionId }) },
    );

    expect(malformed.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a successful upstream record bound to another division", async () => {
    const body = { name: "Harbour", entry_type: "team", seed: 1, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      return Response.json({
        id: "77df44ed-d7c0-4721-8577-8098285c5591",
        division_id: "00000000-0000-4000-8000-000000000999",
        name: "Harbour",
        seed: 1,
        status: "active",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createEntry(
      request(`/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries`, body),
      { params: Promise.resolve({ competitionId, divisionId }) },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "COMMAND_RESPONSE_INVALID" } });
  });

  it("rejects a successful upstream division with a different entry limit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      return Response.json({
        id: "77df44ed-d7c0-4721-8577-8098285c5591",
        competition_id: competitionId,
        name: "Open",
        code: null,
        team_limit: 16,
        revision: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createDivision(
      request(`/api/phase3/competitions/${competitionId}/divisions`, {
        name: "Open",
        entry_limit: 8,
        idempotency_key: idempotencyKey,
      }),
      { params: Promise.resolve({ competitionId }) },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "COMMAND_RESPONSE_INVALID" } });
  });
});

describe("planned team BFF", () => {
  const entryId = "77df44ed-d7c0-4721-8577-8098285c5591";
  const placeholder = (index: number) => ({
    id: `00000000-0000-4000-8000-00000000010${index}`,
    division_id: divisionId,
    name: `Open ${index}`,
    entry_type: "placeholder",
    status: "active",
    seed: null,
    revision: 1,
  });

  it("forwards planned_entry_count and returns the created placeholders", async () => {
    const body = { name: "Open", entry_limit: 8, planned_entry_count: 2, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json(
        {
          id: divisionId,
          competition_id: competitionId,
          name: "Open",
          code: null,
          team_limit: 8,
          revision: 1,
          entries: [placeholder(1), placeholder(2)],
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createDivision(request(`/api/phase3/competitions/${competitionId}/divisions`, body), {
      params: Promise.resolve({ competitionId }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).entries).toHaveLength(2);
  });

  it("rejects a division response whose placeholder count does not match the request", async () => {
    const body = { name: "Open", entry_limit: 8, planned_entry_count: 3, idempotency_key: idempotencyKey };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/v1/identity/me")) return identity();
        return Response.json({
          id: divisionId,
          competition_id: competitionId,
          name: "Open",
          team_limit: 8,
          entries: [placeholder(1)],
        });
      }),
    );

    const response = await createDivision(request(`/api/phase3/competitions/${competitionId}/divisions`, body), {
      params: Promise.resolve({ competitionId }),
    });

    expect(response.status).toBe(502);
  });

  it("rejects a planned count above the division limit before an upstream write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await createDivision(
      request(`/api/phase3/competitions/${competitionId}/divisions`, {
        name: "Open",
        entry_limit: 8,
        planned_entry_count: 9,
        idempotency_key: idempotencyKey,
      }),
      { params: Promise.resolve({ competitionId }) },
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plans more placeholders for an existing division", async () => {
    const body = { count: 2, idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identity();
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/plan`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json({ division_id: divisionId, entries: [placeholder(1), placeholder(2)] }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await planEntries(
      request(`/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries/plan`, body),
      { params: Promise.resolve({ competitionId, divisionId }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).entries).toHaveLength(2);
  });

  it("preserves the format lock rejection and rejects malformed plan commands", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/identity/me")) return identity();
      return Response.json(
        { error: { code: "ENTRY_MUTATION_LOCKED_BY_FORMAT", message: "Entries are locked by the format" } },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const path = `/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries/plan`;
    const params = { params: Promise.resolve({ competitionId, divisionId }) };

    const locked = await planEntries(request(path, { count: 1, idempotency_key: idempotencyKey }), params);
    const malformed = await planEntries(request(path, { count: 0, idempotency_key: idempotencyKey }), {
      params: Promise.resolve({ competitionId, divisionId }),
    });

    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: { code: "ENTRY_MUTATION_LOCKED_BY_FORMAT" } });
    expect(malformed.status).toBe(400);
  });

  it("renames a placeholder into a named team with PATCH", async () => {
    const body = { revision: 1, name: "Harbour", entry_type: "team", idempotency_key: idempotencyKey };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/me")) return identity();
      expect(url).toBe(`${origin}/api/v1/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json({
        id: entryId,
        division_id: divisionId,
        name: "Harbour",
        entry_type: "team",
        status: "active",
        seed: null,
        revision: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await updateEntry(
      request(
        `/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}`,
        body,
        origin,
        "PATCH",
      ),
      { params: Promise.resolve({ competitionId, divisionId, entryId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Harbour", entry_type: "team", revision: 2 });
  });

  it("preserves a stale-revision rejection on rename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/v1/identity/me")) return identity();
        return Response.json({ error: { code: "REVISION_CONFLICT", message: "Stale revision" } }, { status: 409 });
      }),
    );

    const response = await updateEntry(
      request(
        `/api/phase3/competitions/${competitionId}/divisions/${divisionId}/entries/${entryId}`,
        { revision: 1, name: "Harbour", entry_type: "team", idempotency_key: idempotencyKey },
        origin,
        "PATCH",
      ),
      { params: Promise.resolve({ competitionId, divisionId, entryId }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  });
});
