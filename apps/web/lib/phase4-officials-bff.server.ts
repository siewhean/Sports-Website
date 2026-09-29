import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  exact,
  isOfficialWorkspaceResponse,
  isUuid,
  isoDate,
  phase4OfficialsCopy,
  phase4OfficialsMachine,
  record,
} from "@/lib/phase4-officials";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export type ValidationResult<T> = { ok: true; body: T } | { ok: false; message: string };

export function validationError(message: string) {
  return NextResponse.json({ error: { code: phase4OfficialsMachine.validationError, message } }, { status: 400 });
}

export async function forwardWorkspaceGet(request: NextRequest, competitionId: string) {
  const result = await readPhase3Json(
    request,
    `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials/workspace`,
  );

  if (!result.ok) {
    if (result.payload && typeof result.payload === "object") {
      return NextResponse.json(result.payload, { status: result.status });
    }
    const code =
      result.status === 401
        ? phase4OfficialsMachine.authRequired
        : result.status === 503
          ? phase4OfficialsMachine.apiUnavailable
          : phase4OfficialsMachine.upstreamError;
    return NextResponse.json({ error: { code, message: phase4OfficialsCopy.errorBody } }, { status: result.status });
  }

  if (!isOfficialWorkspaceResponse(result.payload)) {
    return NextResponse.json(
      { error: { code: phase4OfficialsMachine.commandResponseInvalid, message: phase4OfficialsCopy.errorBody } },
      { status: 502 },
    );
  }

  return NextResponse.json(result.payload, {
    status: 200,
    headers: { [phase4OfficialsMachine.cacheControl]: phase4OfficialsMachine.noStore },
  });
}

export function validateCreateOfficialBody(
  raw: unknown,
): ValidationResult<{ name: string; default_role?: string | null }> {
  const row = record(raw);
  if (!row) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const keys = Object.keys(row).sort();
  const validKeys =
    keys.length === 1 && keys[0] === "name"
      ? true
      : keys.length === 2 && keys[0] === "default_role" && keys[1] === "name";
  if (!validKeys) {
    return { ok: false, message: "Create official accepts only name and optional default_role" };
  }

  if (typeof row.name !== "string" || row.name.trim().length < 1 || row.name.length > 80) {
    return { ok: false, message: "Official name must be between 1 and 80 characters" };
  }

  const result: { name: string; default_role?: string | null } = {
    name: row.name.trim(),
  };

  if ("default_role" in row) {
    if (
      row.default_role !== null &&
      (typeof row.default_role !== "string" || row.default_role.trim().length < 1 || row.default_role.length > 40)
    ) {
      return { ok: false, message: "Default role must be null or between 1 and 40 characters" };
    }
    result.default_role = typeof row.default_role === "string" ? row.default_role.trim() : null;
  }

  return { ok: true, body: result };
}

export function validateUpdateOfficialBody(raw: unknown): ValidationResult<Record<string, unknown>> {
  const row = record(raw);
  if (!row) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const keys = Object.keys(row).sort();
  if (keys.length === 0) {
    return { ok: false, message: "Update official requires at least one field to update" };
  }
  for (const k of keys) {
    if (k !== "name" && k !== "default_role") {
      return { ok: false, message: `Unknown field '${k}' in update official body` };
    }
  }

  const result: Record<string, unknown> = {};

  if ("name" in row) {
    if (typeof row.name !== "string" || row.name.trim().length < 1 || row.name.length > 80) {
      return { ok: false, message: "Official name must be between 1 and 80 characters" };
    }
    result.name = row.name.trim();
  }

  if ("default_role" in row) {
    if (
      row.default_role !== null &&
      (typeof row.default_role !== "string" || row.default_role.trim().length < 1 || row.default_role.length > 40)
    ) {
      return { ok: false, message: "Default role must be null or between 1 and 40 characters" };
    }
    result.default_role = typeof row.default_role === "string" ? row.default_role.trim() : null;
  }

  return { ok: true, body: result };
}

export function validateEmptyBody(raw: unknown): { ok: true } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    return { ok: true };
  }
  return { ok: false, message: "Unexpected request body for mutation" };
}

export function validateAvailabilityBody(
  raw: unknown,
): ValidationResult<{ windows: Array<{ starts_at: string; ends_at: string }> }> {
  const row = record(raw);
  if (!row || !exact(row, ["windows"])) {
    return { ok: false, message: "Availability body must contain exactly the 'windows' array" };
  }
  if (!Array.isArray(row.windows)) {
    return { ok: false, message: "'windows' must be an array" };
  }
  if (row.windows.length > 512) {
    return { ok: false, message: "Maximum 512 availability windows allowed" };
  }

  const windows: Array<{ starts_at: string; ends_at: string }> = [];
  for (const item of row.windows) {
    const w = record(item);
    if (!w || !exact(w, ["ends_at", "starts_at"])) {
      return { ok: false, message: "Each availability window must contain exactly starts_at and ends_at" };
    }
    if (!isoDate(w.starts_at) || !isoDate(w.ends_at)) {
      return { ok: false, message: "Window timestamps must be valid ISO date-time strings" };
    }
    if (Date.parse(w.starts_at) >= Date.parse(w.ends_at)) {
      return { ok: false, message: "Window starts_at must be before ends_at" };
    }
    windows.push({
      starts_at: w.starts_at,
      ends_at: w.ends_at,
    });
  }

  return { ok: true, body: { windows } };
}

export function validateMatchAssignmentsBody(
  raw: unknown,
): ValidationResult<{ assignments: Array<{ official_id: string; assigned_role: string | null }> }> {
  const row = record(raw);
  if (!row || !exact(row, ["assignments"])) {
    return { ok: false, message: "Assignments body must contain exactly the 'assignments' array" };
  }
  if (!Array.isArray(row.assignments)) {
    return { ok: false, message: "'assignments' must be an array" };
  }
  if (row.assignments.length > 64) {
    return { ok: false, message: "Maximum 64 match assignments allowed" };
  }

  const seenOfficialIds = new Set<string>();
  const assignments: Array<{ official_id: string; assigned_role: string | null }> = [];

  for (const item of row.assignments) {
    const a = record(item);
    if (!a) {
      return { ok: false, message: "Each assignment must be an object" };
    }
    for (const key of Object.keys(a)) {
      if (key !== "official_id" && key !== "assigned_role") {
        return { ok: false, message: `Unknown field '${key}' in assignment item` };
      }
    }
    if (!("official_id" in a)) {
      return { ok: false, message: "Assignment item missing required 'official_id'" };
    }
    if (!isUuid(a.official_id)) {
      return { ok: false, message: "Assignment official_id must be a valid UUID" };
    }
    if (seenOfficialIds.has(a.official_id)) {
      return { ok: false, message: `Duplicate official assignment for '${a.official_id}'` };
    }
    seenOfficialIds.add(a.official_id);

    let assignedRole: string | null = null;
    if ("assigned_role" in a && a.assigned_role !== undefined && a.assigned_role !== null) {
      if (typeof a.assigned_role !== "string" || a.assigned_role.trim().length < 1 || a.assigned_role.length > 40) {
        return { ok: false, message: "Assigned role must be null or between 1 and 40 characters" };
      }
      assignedRole = a.assigned_role.trim();
    }

    assignments.push({
      official_id: a.official_id,
      assigned_role: assignedRole,
    });
  }

  return { ok: true, body: { assignments } };
}
