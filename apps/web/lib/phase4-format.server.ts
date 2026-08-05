import "server-only";

import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";

import { cookies, headers } from "next/headers";
import type { Phase4FormatBuilderDocument, Phase4FormatDraftView } from "@matchday/contracts";
import { cookieHostMatches, publicRequestHost } from "@/lib/phase2-organiser";
import {
  parseOrganiserTemplateList,
  parseFormatWorkspaceResponse,
  type FormatBuilderPageDocument,
  type FormatSurfaceState,
} from "@/lib/phase4-format";
import { isLaunchSportCode, parseFormatTemplateCompetitionContext } from "@/lib/phase4-template-context";

function apiBaseUrl(): URL | null {
  try {
    const value = process.env.MATCHDAY_API_BASE_URL?.trim();
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function sessionCookie(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  if (!cookieHostMatches(publicRequestHost(requestHeaders), apiUrl.hostname)) return null;
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

function unavailable(
  competitionId: string,
  competitionName: string,
  divisionId: string,
  divisionName: string,
  sportCode: string,
  state: FormatSurfaceState,
): FormatBuilderPageDocument {
  return {
    state,
    competitionId,
    competitionName,
    divisionId,
    divisionName,
    organisationId: "",
    sportCode,
    draft: null,
    templates: [],
  };
}

function demoDocument(): Phase4FormatBuilderDocument {
  const groupMatches: Array<Phase4FormatBuilderDocument["graph"]["matches"][number]> = [];
  let groupOrder = 1;
  for (const group of [
    { stageId: "stage-group-a", poolId: "A", seeds: [1, 2, 3, 4] },
    { stageId: "stage-group-b", poolId: "B", seeds: [5, 6, 7, 8] },
  ]) {
    for (let homeIndex = 0; homeIndex < group.seeds.length; homeIndex += 1) {
      for (let awayIndex = homeIndex + 1; awayIndex < group.seeds.length; awayIndex += 1) {
        groupMatches.push({
          id: `match-${group.poolId.toLowerCase()}-${group.seeds[homeIndex]}-${group.seeds[awayIndex]}`,
          stageId: group.stageId,
          poolId: group.poolId,
          round: homeIndex + 1,
          order: groupOrder,
          purpose: "pool",
          home: { type: "entry_seed", seed: group.seeds[homeIndex]! },
          away: { type: "entry_seed", seed: group.seeds[awayIndex]! },
        });
        groupOrder += 1;
      }
    }
  }
  const stages = [
    {
      id: "stage-group-a",
      label: "Group A",
      kind: "group" as const,
      order: 1,
      groupIds: ["A"],
      groupSize: 4,
      outputRanks: 2,
      matchIds: groupMatches.filter((match) => match.stageId === "stage-group-a").map((match) => match.id),
      repetitions: 1,
      qualificationPositions: [1, 2],
      destinationStageIds: ["stage-semifinals"],
      seeding: "snake" as const,
      carriedResults: "none" as const,
    },
    {
      id: "stage-group-b",
      label: "Group B",
      kind: "group" as const,
      order: 2,
      groupIds: ["B"],
      groupSize: 4,
      outputRanks: 2,
      matchIds: groupMatches.filter((match) => match.stageId === "stage-group-b").map((match) => match.id),
      repetitions: 1,
      qualificationPositions: [1, 2],
      destinationStageIds: ["stage-semifinals"],
      seeding: "snake" as const,
      carriedResults: "none" as const,
    },
    {
      id: "stage-semifinals",
      label: "Semifinals",
      kind: "single_elimination" as const,
      order: 3,
      groupIds: [],
      groupSize: null,
      outputRanks: 2,
      matchIds: ["match-sf1", "match-sf2"],
      qualificationPositions: [1],
      destinationStageIds: ["stage-final", "stage-bronze"],
      seeding: "seeded" as const,
    },
    {
      id: "stage-bronze",
      label: "Third-place",
      kind: "bronze" as const,
      order: 4,
      groupIds: [],
      groupSize: null,
      outputRanks: 1,
      matchIds: ["match-bronze"],
      qualificationPositions: [1],
      destinationStageIds: [],
      placementRule: { coverage: "podium" as const, positions: [3] },
    },
    {
      id: "stage-final",
      label: "Final",
      kind: "single_elimination" as const,
      order: 5,
      groupIds: [],
      groupSize: null,
      outputRanks: 1,
      matchIds: ["match-final"],
      qualificationPositions: [1],
      destinationStageIds: [],
      placementRule: { coverage: "champion_only" as const, positions: [1, 2] },
    },
  ];
  return {
    schema_version: 1,
    graph: {
      id: "format-singapore-open",
      schemaVersion: 1,
      entryCount: 8,
      stages,
      matches: [
        ...groupMatches,
        {
          id: "match-sf1",
          stageId: "stage-semifinals",
          round: 1,
          order: 1,
          purpose: "progression",
          home: { type: "stage_rank", stageId: "stage-group-a", groupId: "A", rank: 1 },
          away: { type: "stage_rank", stageId: "stage-group-b", groupId: "B", rank: 2 },
        },
        {
          id: "match-sf2",
          stageId: "stage-semifinals",
          round: 1,
          order: 2,
          purpose: "progression",
          home: { type: "stage_rank", stageId: "stage-group-b", groupId: "B", rank: 1 },
          away: { type: "stage_rank", stageId: "stage-group-a", groupId: "A", rank: 2 },
        },
        {
          id: "match-bronze",
          stageId: "stage-bronze",
          round: 1,
          order: 3,
          purpose: "placement",
          home: { type: "loser", matchId: "match-sf1" },
          away: { type: "loser", matchId: "match-sf2" },
        },
        {
          id: "match-final",
          stageId: "stage-final",
          round: 1,
          order: 4,
          purpose: "championship",
          home: { type: "winner", matchId: "match-sf1" },
          away: { type: "winner", matchId: "match-sf2" },
        },
      ],
      terminalMatchIds: ["match-bronze", "match-final"],
    },
    layout: {
      schema_version: 1,
      stage_positions: [
        { stage_id: "stage-group-a", x: 42, y: 70 },
        { stage_id: "stage-group-b", x: 42, y: 305 },
        { stage_id: "stage-semifinals", x: 350, y: 187 },
        { stage_id: "stage-bronze", x: 650, y: 350 },
        { stage_id: "stage-final", x: 735, y: 125 },
      ],
    },
  };
}

function demoDraft(competitionId: string, divisionId: string, readOnly = false): Phase4FormatDraftView {
  const draftId =
    divisionId === "women" ? "6b3f7665-c8cd-47e5-b243-fae28f56f6fe" : "5a2f6554-b7bc-46d4-a132-e9f17e45e5ed";
  const rootRevisionId =
    divisionId === "women" ? "6a2f6554-b7bc-46d4-a132-e9f17e45e5ed" : "59245771-cf60-4f50-977d-ed558e6eb147";
  return {
    competition_id: competitionId,
    division_id: divisionId,
    draft_id: draftId,
    parent_revision_id: rootRevisionId,
    root_revision_id: rootRevisionId,
    revision: 6,
    status: "draft",
    created_at: "2026-07-20T04:00:00.000Z",
    updated_at: "2026-07-20T06:34:00.000Z",
    permission: readOnly ? "view" : "edit",
    read_only: readOnly,
    definition_hash: "demo-format-definition-hash",
    document: demoDocument(),
    metrics: { match_count: 16, guaranteed_matches: 3, maximum_matches: 5 },
    capacity: {
      available_match_slots: 52,
      required_match_slots: 31,
      spare_match_slots: 21,
      status: "comfortable",
      evidence_revision: 4,
    },
    validation: { pending: false, validated_definition_hash: "demo-format-definition-hash", issues: [] },
  };
}

export async function getFormatBuilderDocument(input: {
  competitionId: string;
  competitionName: string;
  divisionId: string;
  divisionName: string;
  sportCode: string;
  previewState?: string;
}): Promise<FormatBuilderPageDocument> {
  if (!isLaunchSportCode(input.sportCode))
    return unavailable(
      input.competitionId,
      input.competitionName,
      input.divisionId,
      input.divisionName,
      input.sportCode,
      "error",
    );
  if (demoFixturesEnabled()) {
    const allowed = new Set<FormatSurfaceState>([
      "ready",
      "loading",
      "empty",
      "error",
      "offline",
      "permission",
      "read-only",
      "conflict",
      "quota",
      "plan",
    ]);
    const state = allowed.has(input.previewState as FormatSurfaceState)
      ? (input.previewState as FormatSurfaceState)
      : "ready";
    if (state !== "ready" && state !== "read-only")
      return unavailable(
        input.competitionId,
        input.competitionName,
        input.divisionId,
        input.divisionName,
        input.sportCode,
        state,
      );
    return {
      state,
      competitionId: input.competitionId,
      competitionName: input.competitionName,
      divisionId: input.divisionId,
      divisionName: input.divisionName,
      organisationId: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
      sportCode: input.sportCode,
      draft: demoDraft(input.competitionId, input.divisionId, state === "read-only"),
      templates: [],
    };
  }
  const base = apiBaseUrl();
  if (!base)
    return unavailable(
      input.competitionId,
      input.competitionName,
      input.divisionId,
      input.divisionName,
      input.sportCode,
      "error",
    );
  const cookie = await sessionCookie(base);
  if (!cookie)
    return unavailable(
      input.competitionId,
      input.competitionName,
      input.divisionId,
      input.divisionName,
      input.sportCode,
      "permission",
    );
  try {
    const [response, competitionResponse] = await Promise.all([
      fetch(
        new URL(
          `/api/v1/competitions/${encodeURIComponent(input.competitionId)}/divisions/${encodeURIComponent(input.divisionId)}/format-builder`,
          base,
        ),
        { cache: "no-store", headers: { accept: "application/json", cookie } },
      ),
      fetch(new URL(`/api/v1/competitions/${encodeURIComponent(input.competitionId)}`, base), {
        cache: "no-store",
        headers: { accept: "application/json", cookie },
      }),
    ]);
    if (response.status === 404)
      return unavailable(
        input.competitionId,
        input.competitionName,
        input.divisionId,
        input.divisionName,
        input.sportCode,
        "empty",
      );
    if ([response.status, competitionResponse.status].some((status) => status === 401 || status === 403))
      return unavailable(
        input.competitionId,
        input.competitionName,
        input.divisionId,
        input.divisionName,
        input.sportCode,
        "permission",
      );
    if (!response.ok || !competitionResponse.ok)
      return unavailable(
        input.competitionId,
        input.competitionName,
        input.divisionId,
        input.divisionName,
        input.sportCode,
        "error",
      );
    const parsed = parseFormatWorkspaceResponse(
      await response.json().catch(() => null),
      input.competitionId,
      input.divisionId,
    );
    const context = parseFormatTemplateCompetitionContext(
      await competitionResponse.json().catch(() => null),
      input.competitionId,
    );
    if (!parsed || !context)
      return unavailable(
        input.competitionId,
        input.competitionName,
        input.divisionId,
        input.divisionName,
        input.sportCode,
        "error",
      );

    let templates = [] as FormatBuilderPageDocument["templates"];
    const templateResponse = await fetch(
      new URL(`/api/v1/organisations/${encodeURIComponent(context.organisationId)}/format-templates`, base),
      { cache: "no-store", headers: { accept: "application/json", cookie } },
    );
    if (templateResponse.ok)
      templates = (
        parseOrganiserTemplateList(await templateResponse.json().catch(() => null), context.organisationId) ?? []
      ).filter((template) => template.sport_code === context.sportCode);

    return {
      state: parsed.draft ? (parsed.draft.read_only ? "read-only" : "ready") : "empty",
      competitionId: input.competitionId,
      competitionName: input.competitionName,
      divisionId: input.divisionId,
      divisionName: input.divisionName,
      organisationId: context.organisationId,
      sportCode: context.sportCode,
      draft: parsed.draft,
      templates,
    };
  } catch {
    return unavailable(
      input.competitionId,
      input.competitionName,
      input.divisionId,
      input.divisionName,
      input.sportCode,
      "offline",
    );
  }
}
