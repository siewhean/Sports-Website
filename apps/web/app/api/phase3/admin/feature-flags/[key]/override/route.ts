import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { featureFlags } from "@matchday/feature-flags";
import { featureFlagAdminMachine } from "@/lib/phase3-feature-flags-admin";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function PUT(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!Object.prototype.hasOwnProperty.call(featureFlags, key)) {
    return NextResponse.json(
      {
        error: {
          code: featureFlagAdminMachine.notFoundCode,
          message: `${featureFlagAdminMachine.notFoundCode}: ${key}`,
        },
      },
      { status: 404 },
    );
  }

  const body = await jsonBody(request);
  if (!body) {
    return NextResponse.json(
      { error: { code: featureFlagAdminMachine.requestInvalid, message: featureFlagAdminMachine.requestBodyRequired } },
      { status: 400 },
    );
  }

  // Required keys: scope, value, reason. Optional: expected_updated_at.
  if (!isRecord(body.scope) || typeof body.reason !== "string" || body.reason.trim().length < 3) {
    return NextResponse.json(
      { error: { code: featureFlagAdminMachine.validationError, message: featureFlagAdminMachine.validationMessage } },
      { status: 400 },
    );
  }

  return forwardPhase3Mutation(request, {
    method: featureFlagAdminMachine.put,
    path: `/api/v1/admin/feature-flags/${encodeURIComponent(key)}/override`,
    body,
    validate: (payload) => isRecord(payload) && typeof payload.key === "string",
  });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!Object.prototype.hasOwnProperty.call(featureFlags, key)) {
    return NextResponse.json(
      {
        error: {
          code: featureFlagAdminMachine.notFoundCode,
          message: `${featureFlagAdminMachine.notFoundCode}: ${key}`,
        },
      },
      { status: 404 },
    );
  }

  const body = await jsonBody(request);
  if (!body || !isRecord(body.scope) || typeof body.reason !== "string" || body.reason.trim().length < 3) {
    return NextResponse.json(
      {
        error: {
          code: featureFlagAdminMachine.validationError,
          message: featureFlagAdminMachine.validationDeleteMessage,
        },
      },
      { status: 400 },
    );
  }

  return forwardPhase3Mutation(request, {
    method: featureFlagAdminMachine.delete,
    path: `/api/v1/admin/feature-flags/${encodeURIComponent(key)}/override`,
    body,
    validate: (payload) => isRecord(payload) && payload.success === true,
  });
}
