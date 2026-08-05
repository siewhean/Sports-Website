import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseCreatedEntry, phase3EntriesCopy, phase3EntriesMachine } from "@/lib/phase3-entries";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

function updateBody(
  value: Record<string, unknown> | null,
): value is { revision: number; name: string; seed: number | null; idempotency_key: string } {
  return Boolean(
    value &&
    Object.keys(value).sort().join(",") === "idempotency_key,name,revision,seed" &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotency_key) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.trim().length <= 120 &&
    (value.seed === null ||
      (Number.isInteger(value.seed) && (value.seed as number) >= 1 && (value.seed as number) <= 48)),
  );
}

function deleteBody(value: Record<string, unknown> | null): value is { revision: number; idempotency_key: string } {
  return Boolean(
    value &&
    Object.keys(value).sort().join(",") === "idempotency_key,revision" &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotency_key),
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string; entryId: string }> },
) {
  const body = await jsonBody(request);
  if (!updateBody(body))
    return NextResponse.json(
      { error: { code: phase3EntriesMachine.entryCommandInvalid, message: phase3EntriesCopy.commandFailed } },
      { status: 400 },
    );
  const { competitionId, divisionId, entryId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3EntriesMachine.patch,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries/${encodeURIComponent(entryId)}`,
    body,
    validate: (value) => parseCreatedEntry(value, divisionId)?.id === entryId,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string; entryId: string }> },
) {
  const body = await jsonBody(request);
  if (!deleteBody(body))
    return NextResponse.json(
      { error: { code: phase3EntriesMachine.entryCommandInvalid, message: phase3EntriesCopy.commandFailed } },
      { status: 400 },
    );
  const { competitionId, divisionId, entryId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3EntriesMachine.delete,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries/${encodeURIComponent(entryId)}`,
    body,
    validate: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return Object.keys(item).sort().join(",") === "deleted,id" && item.id === entryId && item.deleted === true;
    },
  });
}
