import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { isMatchOfficialsMutationResponse, phase4OfficialsMachine } from "@/lib/phase4-officials";
import { validateMatchAssignmentsBody, validationError } from "@/lib/phase4-officials-bff.server";
import { DEMO_SCOPE_COOKIE, resolveDemoScope, updateDemoMatchAssignments } from "@/lib/phase4-officials.server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const { competitionId, matchId } = await params;
  const raw = await jsonBody(request);
  const validated = validateMatchAssignmentsBody(raw);
  if (!validated.ok) {
    return validationError(validated.message);
  }

  if (demoFixturesEnabled()) {
    const scope = resolveDemoScope(request.cookies.get(DEMO_SCOPE_COOKIE)?.value);
    const result = updateDemoMatchAssignments(competitionId, matchId, validated.body.assignments, scope);
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.errorCode, message: result.message } },
        { status: result.status },
      );
    }
    return NextResponse.json({
      assignments: result.assignments.map((a) => ({
        match_id: a.matchId,
        official_id: a.officialId,
        assigned_role: a.assignedRole,
      })),
      bumped_revision: result.bumpedRevision,
    });
  }

  return forwardPhase3Mutation(request, {
    method: phase4OfficialsMachine.put,
    path: `/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/officials`,
    body: validated.body,
    validate: isMatchOfficialsMutationResponse,
  });
}
