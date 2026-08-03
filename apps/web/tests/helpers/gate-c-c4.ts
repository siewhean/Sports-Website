import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import type { GateCRepairActionKind } from "@matchday/contracts";

export const gateCC4Ids = {
  competition: "11111111-1111-4111-8111-111111111111",
  division: "22222222-2222-4222-8222-222222222222",
  correctedMatch: "33333333-3333-4333-8333-333333333333",
  downstreamMatch: "44444444-4444-4444-8444-444444444444",
  correction: "55555555-5555-4555-8555-555555555555",
  resultRepair: "66666666-6666-4666-8666-666666666666",
  repair: "77777777-7777-4777-8777-777777777777",
  revision: "88888888-8888-4888-8888-888888888888",
  readyRevision: "99999999-9999-4999-8999-999999999999",
  action: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  currentEntry: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  proposedEntry: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  manualEntry: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  area: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  actor: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  scheduleRevision: "12121212-1212-4121-8121-121212121212",
} as const;

const fingerprint = "a".repeat(64);
const createdAt = "2026-08-01T00:00:00.000Z";

type GateCC4FixtureOptions = Readonly<{
  action?: GateCRepairActionKind;
  referenceMatches?: readonly Readonly<{ id: string; label: string; home: string; away: string }>[];
}>;

export function gateCC4Workspace(ready = false, options: GateCC4FixtureOptions = {}) {
  const sourceAction = options.action ?? "automatic_update";
  const protectedAction = sourceAction === "protected_started_match" || sourceAction === "protected_finalised_match";
  const revisionId = ready ? gateCC4Ids.readyRevision : gateCC4Ids.revision;
  const decision = ready ? (protectedAction ? "keep_current" : "accept_proposed") : null;
  return {
    repair: {
      repair_id: gateCC4Ids.repair,
      competition_id: gateCC4Ids.competition,
      corrected_match_id: gateCC4Ids.correctedMatch,
      source_result_version: 7,
      source_schedule_version: 4,
      status: "drafted",
      analysis: {
        schema_version: 1,
        competition_id: gateCC4Ids.competition,
        corrected_match_id: gateCC4Ids.correctedMatch,
        source_result_version: 7,
        source_schedule_version: 4,
        affected_division_ids: [gateCC4Ids.division],
        actions: [
          {
            match_id: gateCC4Ids.downstreamMatch,
            division_id: gateCC4Ids.division,
            slot: "home",
            current_entry_id: gateCC4Ids.currentEntry,
            proposed_entry_id: gateCC4Ids.proposedEntry,
            match_state: sourceAction === "protected_finalised_match" ? "final" : "ready",
            control: "automatic",
            action: sourceAction,
            reason: protectedAction
              ? "The downstream match is protected and requires an organiser decision."
              : "The downstream match can be updated in the private repair revision.",
            dependency_path: [
              {
                source_match_id: gateCC4Ids.correctedMatch,
                downstream_match_id: gateCC4Ids.downstreamMatch,
                slot: "home",
                outcome: "winner",
              },
            ],
          },
        ],
        analysis_fingerprint_input: JSON.stringify({ corrected_match_id: gateCC4Ids.correctedMatch }),
      },
      created_at: createdAt,
      created_by_account_id: gateCC4Ids.actor,
    },
    latest_revision: {
      repair_revision_id: revisionId,
      repair_id: gateCC4Ids.repair,
      revision: ready ? 2 : 1,
      status: ready ? "ready" : "draft",
      source_result_version: 7,
      source_schedule_version: 4,
      analysis_fingerprint: fingerprint,
      analysis_fingerprint_input: JSON.stringify({ corrected_match_id: gateCC4Ids.correctedMatch }),
      created_at: createdAt,
      created_by_account_id: gateCC4Ids.actor,
    },
    actions: [
      {
        repair_action_id: gateCC4Ids.action,
        repair_revision_id: revisionId,
        ordinal: 1,
        match_id: gateCC4Ids.downstreamMatch,
        division_id: gateCC4Ids.division,
        slot: "home",
        source_action: sourceAction,
        decision,
        current_entry_id: gateCC4Ids.currentEntry,
        proposed_entry_id: gateCC4Ids.proposedEntry,
        resolved_entry_id: ready ? (protectedAction ? gateCC4Ids.currentEntry : gateCC4Ids.proposedEntry) : null,
        reason: ready
          ? protectedAction
            ? "Keep the protected participant before the repaired schedule is published."
            : "Accept the corrected winner before the repaired schedule is published."
          : protectedAction
            ? "The downstream match is protected and requires an organiser decision."
            : "The downstream match can be updated in the private repair revision.",
        dependency_path: [
          {
            source_match_id: gateCC4Ids.correctedMatch,
            downstream_match_id: gateCC4Ids.downstreamMatch,
            slot: "home",
            outcome: "winner",
          },
        ],
        created_at: createdAt,
        current_entry_name: "Marina Blue",
        proposed_entry_name: "Harbour Gold",
        resolved_entry_name: ready ? (protectedAction ? "Marina Blue" : "Harbour Gold") : null,
        match_code: "M12",
        adjustment: null,
      },
    ],
    unresolved_action_keys: ready ? [] : [`${gateCC4Ids.downstreamMatch}:home`],
    publication_ready: ready,
    current_result_version: 7,
    published_schedule_version: 4,
    public_projection_versions: { [gateCC4Ids.division]: 2 },
    audit: [
      {
        occurred_at: createdAt,
        actor_account_id: gateCC4Ids.actor,
        action: "repair.created",
        target_type: "schedule_repair_case",
        target_id: gateCC4Ids.repair,
        reason: null,
      },
    ],
  } as const;
}

function queue(status: "draft" | "ready" | "published") {
  return [
    {
      repair_id: gateCC4Ids.repair,
      corrected_match_id: gateCC4Ids.correctedMatch,
      corrected_match_code: "M12",
      division_id: gateCC4Ids.division,
      division_name: "Open division",
      source_result_version: 7,
      source_schedule_version: 4,
      source_projection_version: 2,
      analysis_fingerprint: fingerprint,
      latest_revision_id: status === "draft" ? gateCC4Ids.revision : gateCC4Ids.readyRevision,
      latest_revision: status === "draft" ? 1 : 2,
      latest_status: status,
      affected_action_count: 1,
      unresolved_action_count: status === "draft" ? 1 : 0,
      created_at: createdAt,
    },
  ];
}

const pending = [
  {
    result_repair_case_id: gateCC4Ids.resultRepair,
    correction_transaction_id: gateCC4Ids.correction,
    corrected_match_id: gateCC4Ids.correctedMatch,
    corrected_match_code: "M12",
    division_id: gateCC4Ids.division,
    division_name: "Open division",
    source_result_version: 7,
    created_at: createdAt,
  },
];

const references = {
  entries: [
    { id: gateCC4Ids.currentEntry, division_id: gateCC4Ids.division, name: "Marina Blue" },
    { id: gateCC4Ids.proposedEntry, division_id: gateCC4Ids.division, name: "Harbour Gold" },
    { id: gateCC4Ids.manualEntry, division_id: gateCC4Ids.division, name: "Kallang Current" },
  ],
  playing_areas: [{ id: gateCC4Ids.area, name: "Court 1" }],
  matches: [
    {
      id: gateCC4Ids.correctedMatch,
      label: "M12",
      home: "Marina Blue",
      away: "Harbour Gold",
    },
  ],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export type GateCC4BrowserController = {
  revisionRequests: Array<Record<string, unknown>>;
  publicationRequests: Array<Record<string, unknown>>;
  abandonRequests: Array<Record<string, unknown>>;
  setReady(value: boolean): void;
};

export async function installGateCC4BrowserRoutes(
  page: Page,
  options: GateCC4FixtureOptions = {},
): Promise<GateCC4BrowserController> {
  let ready = false;
  let published = false;
  let pendingVisible = true;
  const revisionRequests: Array<Record<string, unknown>> = [];
  const publicationRequests: Array<Record<string, unknown>> = [];
  const abandonRequests: Array<Record<string, unknown>> = [];

  await page.route("**/api/gate-c/competitions/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path.endsWith("/repairs/pending") && method === "GET") {
      await json(route, pendingVisible ? pending : []);
      return;
    }
    if (path.endsWith("/references") && method === "GET") {
      await json(route, { ...references, matches: options.referenceMatches ?? references.matches });
      return;
    }
    if (path.endsWith("/repairs") && method === "GET") {
      await json(route, published ? queue("published") : queue(ready ? "ready" : "draft"));
      return;
    }
    if (path.endsWith("/repairs") && method === "POST") {
      pendingVisible = false;
      await json(route, gateCC4Workspace(false, options));
      return;
    }
    if (/\/repairs\/[^/]+\/revisions\/[^/]+\/publish$/u.test(path) && method === "POST") {
      publicationRequests.push(request.postDataJSON() as Record<string, unknown>);
      published = true;
      await json(route, {
        competition_id: gateCC4Ids.competition,
        repair_id: gateCC4Ids.repair,
        repair_revision_id: gateCC4Ids.readyRevision,
        schedule_version: 5,
        result_version: 7,
        projection_version: 3,
        schedule_revision_id: gateCC4Ids.scheduleRevision,
        analysis_fingerprint: fingerprint,
        duplicate: false,
        published_at: "2026-08-01T00:01:00.000Z",
      });
      return;
    }
    if (/\/repairs\/[^/]+\/revisions$/u.test(path) && method === "POST") {
      revisionRequests.push(request.postDataJSON() as Record<string, unknown>);
      ready = true;
      await json(
        route,
        {
          revision: gateCC4Workspace(true, options).latest_revision,
          actions: gateCC4Workspace(true, options).actions,
          unresolved_action_keys: [],
          publication_ready: true,
        },
        201,
      );
      return;
    }
    if (/\/repairs\/[^/]+\/abandon$/u.test(path) && method === "POST") {
      abandonRequests.push(request.postDataJSON() as Record<string, unknown>);
      await json(route, {
        repair_id: gateCC4Ids.repair,
        repair_revision_id: gateCC4Ids.readyRevision,
        revision: 3,
        status: "abandoned",
        abandoned_at: "2026-08-01T00:02:00.000Z",
      });
      return;
    }
    if (/\/repairs\/[^/]+$/u.test(path) && method === "GET") {
      await json(route, gateCC4Workspace(ready, options));
      return;
    }
    if (path.endsWith("/exports/schedule") && method === "POST") {
      const bytes = Buffer.from("%PDF-1.7\n% Matchday C4 test\n%%EOF\n", "utf8");
      await route.fulfill({
        status: 200,
        body: bytes,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="national-open-schedule-v4.pdf"',
          "x-matchday-content-sha256": createHash("sha256").update(bytes).digest("hex"),
          "x-matchday-source-fingerprint": fingerprint,
        },
      });
      return;
    }
    if (path.endsWith("/score-sheet") && method === "POST") {
      const bytes = Buffer.from("%PDF-1.7\n% Matchday C4 score sheet\n%%EOF\n", "utf8");
      await route.fulfill({
        status: 200,
        body: bytes,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="national-open-m12-score-sheet.pdf"',
          "x-matchday-content-sha256": createHash("sha256").update(bytes).digest("hex"),
          "x-matchday-source-fingerprint": fingerprint,
        },
      });
      return;
    }
    await route.fallback();
  });

  return {
    revisionRequests,
    publicationRequests,
    abandonRequests,
    setReady(value) {
      ready = value;
    },
  };
}
