/**
 * Track R8: Staging Production Replica Seeder
 *
 * Seeds a comprehensive, realistic copy of production state across all five
 * supported sports, covering active, published, completed, and critically
 * ARCHIVED competitions with frozen match graphs.
 *
 * This replica provides the historical dataset required to catch migration
 * defects (such as the 0073 semifinal relabel archive guard violation) before
 * changes hit production.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { SPORT_PACKS, createDefaultFormatTemplates, type SportId, type FormatGraph } from "@matchday/domain";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { Phase3Runtime, type Phase3Actor } from "../src/phase-3-runtime.js";
import type { PostgresJsSql } from "@matchday/identity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";

import {
  assertDatabaseServerIdentity,
  assertDatabaseStagingMarker,
  assertSafeNonProductionDatabase,
} from "./staging-db-guards.js";

export {
  BLOCKED_PRODUCTION_IP,
  DEFAULT_ALLOWED_STAGING_SERVERS,
  assertDatabaseServerIdentity,
  assertDatabaseStagingMarker,
  assertSafeNonProductionDatabase,
} from "./staging-db-guards.js";

function fourEntryEliminationDefinition(
  formatRevisionId: string,
  semi1Id: string,
  semi2Id: string,
  finalId: string,
): postgres.JSONValue {
  return {
    id: formatRevisionId,
    schemaVersion: 1,
    entryCount: 4,
    stages: [
      {
        id: "knockout",
        label: "Knockout Stage",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: 4,
        matchIds: [semi1Id, semi2Id, finalId],
      },
    ],
    matches: [
      {
        id: semi1Id,
        stageId: "knockout",
        round: 1,
        order: 1,
        purpose: "progression",
        home: { type: "entry_seed", seed: 1 },
        away: { type: "entry_seed", seed: 4 },
      },
      {
        id: semi2Id,
        stageId: "knockout",
        round: 1,
        order: 2,
        purpose: "progression",
        home: { type: "entry_seed", seed: 2 },
        away: { type: "entry_seed", seed: 3 },
      },
      {
        id: finalId,
        stageId: "knockout",
        round: 2,
        order: 3,
        purpose: "championship",
        home: { type: "winner", matchId: semi1Id },
        away: { type: "winner", matchId: semi2Id },
      },
    ],
    terminalMatchIds: [finalId],
  };
}

export async function seedStagingProductionReplica(
  options: { databaseUrl?: string; verbose?: boolean; allowStaging?: boolean } = {},
) {
  const url = options.databaseUrl ?? databaseUrl;
  assertSafeNonProductionDatabase(url, options.allowStaging);
  const verbose = options.verbose ?? true;
  const sql = postgres(url, { max: 4, onnotice: () => undefined });

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  try {
    log("============================================================");
    log(" Track R8: Seeding Staging Production Replica");
    log(` Target Database: ${url.replace(/:[^:@]+@/, ":***@")}`);
    log("============================================================\n");

    // Guards (before any write): the connected server must be an allowlisted staging cluster
    // (covers tunnels/port-forwards), and must carry an operator-created marker bound to that cluster.
    const identity = await assertDatabaseServerIdentity(sql);
    log(` Server identity: system_identifier=${identity.systemIdentifier} database=${identity.database}`);
    await assertDatabaseStagingMarker(sql, identity.systemIdentifier);

    // 1. Ensure active sport packs for all five sports
    log("[1/6] Verifying active sport pack versions for all 5 sports...");
    for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
      const hash = phase3DomainAdapter.hash(pack);
      const existing = await sql<{ version: string }[]>`
        SELECT version FROM sport_pack_versions
        WHERE sport_code = ${sportId} AND status = 'active'
        ORDER BY activated_at DESC NULLS LAST LIMIT 1
      `;
      if (existing.length === 0) {
        await sql`
          INSERT INTO sport_pack_versions (
            sport_code, version, schema_version, definition, definition_hash, status, revision, activated_at
          ) VALUES (
            ${sportId}, ${pack.version}, ${pack.schemaVersion}, ${sql.json(pack)}, ${hash}, 'active', 1, now()
          )
          ON CONFLICT (sport_code, version) DO NOTHING;
        `;
      }
    }

    // 2. Seed Administrator & Organiser Accounts
    log("[2/6] Seeding operator accounts and organisations...");
    const adminAccountId = randomUUID();
    const organiserAccountId = randomUUID();
    const orgNationalFedId = randomUUID();
    const orgMetroClubId = randomUUID();

    await sql`
      INSERT INTO accounts (id, primary_email, display_name, email_verified_at, status)
      VALUES 
        (${adminAccountId}, ${`admin-${adminAccountId.slice(0, 8)}@matchday.test`}, 'Platform Admin', now(), 'active'),
        (${organiserAccountId}, ${`organiser-${organiserAccountId.slice(0, 8)}@matchday.test`}, 'Tournament Organiser', now(), 'active')
      ON CONFLICT DO NOTHING;
    `;

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO organisations (id, name, slug)
        VALUES
          (${orgNationalFedId}, 'Singapore National Sports Federation', ${`snsf-${randomUUID().slice(0, 8)}`}),
          (${orgMetroClubId}, 'Metropolitan Sports League', ${`msl-${randomUUID().slice(0, 8)}`})
        ON CONFLICT DO NOTHING;
      `;
      await tx`
        INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
        VALUES
          (${orgNationalFedId}, ${adminAccountId}, 'owner', 'active'),
          (${orgNationalFedId}, ${organiserAccountId}, 'admin', 'active'),
          (${orgMetroClubId}, ${organiserAccountId}, 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `;
    });

    const actor: Phase3Actor = { accountId: organiserAccountId };
    const phase3 = new Phase3Runtime(sql as unknown as PostgresJsSql, phase3DomainAdapter);

    // 3. Helper to create competition with divisions, entries, and materialised format through app checks
    const createCompetitionGraph = async (params: {
      organisationId: string;
      sportCode: SportId;
      name: string;
      slug: string;
      status: "draft" | "published" | "active" | "completed";
      archived?: boolean;
      archivedFromStatus?: string;
    }) => {
      // Create competition via Phase3Runtime
      const comp = await phase3.createCompetition(
        actor,
        {
          organisationId: params.organisationId,
          name: params.name,
          slug: params.slug,
          sportCode: params.sportCode,
          venue: "Singapore Sports Hub",
          address: "1 Stadium Drive",
          countryCode: "SG",
          startsOn: "2026-09-01",
          endsOn: "2026-09-05",
          timezone: "Asia/Singapore",
          locale: "en-SG",
        },
        randomUUID(),
        `staging-seed-comp-${randomUUID()}`,
      );
      const compId = String(comp.id);
      let revision = Number(comp.revision);

      await sql`UPDATE competitions SET plan_tier = 'organiser_pro' WHERE id = ${compId};`;

      // Create division via Phase3Runtime
      const div = await phase3.createDivision(
        actor,
        compId,
        { name: "Open Championship", code: "OPEN", entryLimit: 8 },
        randomUUID(),
        `staging-seed-div-${randomUUID()}`,
      );
      const divId = String((div as Record<string, unknown>).id);

      // 4 Entries
      for (let i = 0; i < 4; i++) {
        const entryId = randomUUID();
        await sql`
          INSERT INTO division_entries (id, division_id, name, seed, entry_type, status)
          VALUES (${entryId}, ${divId}, ${`Seed Team ${i + 1}`}, ${i + 1}, 'team', 'confirmed');
        `;
      }

      // 4-entry Single Elimination Graph
      const formatRevId = randomUUID();
      const semi1 = randomUUID();
      const semi2 = randomUUID();
      const finalMatch = randomUUID();
      const definition = fourEntryEliminationDefinition(formatRevId, semi1, semi2, finalMatch);
      const [hashRow] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(definition)}) AS hash`;

      await sql`
        INSERT INTO format_revisions (
          id, competition_id, division_id, revision, definition, definition_hash, status, created_by, validation_contract
        ) VALUES (
          ${formatRevId}, ${compId}, ${divId}, 1, ${sql.json(definition)}, ${hashRow!.hash}, 'draft', ${organiserAccountId}, 'phase3'
        );
      `;

      // Materialize matches inside postgres
      await sql`SELECT phase4_materialize_format_revision(${formatRevId});`;

      // Transition competition lifecycle to target status through domain runtime
      if (params.status === "published" || params.status === "active" || params.status === "completed") {
        const readyRes = await phase3.transitionCompetition(actor, compId, { revision, status: "ready" }, randomUUID());
        revision = Number((readyRes as Record<string, unknown>).revision);

        const pubRes = await phase3.transitionCompetition(
          actor,
          compId,
          { revision, status: "published" },
          randomUUID(),
        );
        revision = Number((pubRes as Record<string, unknown>).revision);

        if (params.status === "active" || params.status === "completed") {
          const liveRes = await phase3.transitionCompetition(actor, compId, { revision, status: "live" }, randomUUID());
          revision = Number((liveRes as Record<string, unknown>).revision);

          if (params.status === "completed") {
            const compRes = await phase3.transitionCompetition(
              actor,
              compId,
              { revision, status: "completed" },
              randomUUID(),
            );
            revision = Number((compRes as Record<string, unknown>).revision);
          }
        }
      }

      // If requested, archive the competition via domain runtime checks
      if (params.archived) {
        await phase3.mutateCompetition(actor, compId, { revision, action: "archive" }, randomUUID());
      }

      return { competitionId: compId, divisionId: divId, formatRevisionId: formatRevId };
    };

    // 4. Seed Diverse Competitions (Active, Published, Completed, and ARCHIVED)
    log("[3/6] Seeding multi-sport competitions across all lifecycles...");

    // A. Active Volleyball League (Published)
    const activeVball = await createCompetitionGraph({
      organisationId: orgNationalFedId,
      sportCode: "volleyball",
      name: "National Volleyball League 2026",
      slug: `staging-vball-active-${randomUUID().slice(0, 6)}`,
      status: "published",
    });

    // B. Completed Table Tennis Tournament
    const completedTableTennis = await createCompetitionGraph({
      organisationId: orgMetroClubId,
      sportCode: "table_tennis",
      name: "Metro Table Tennis Spring Open 2026",
      slug: `staging-tt-comp-${randomUUID().slice(0, 6)}`,
      status: "completed",
    });

    // C. ARCHIVED Basketball Knockout (Archived from Completed) -> The 0073 Pattern
    const archivedBasketball = await createCompetitionGraph({
      organisationId: orgNationalFedId,
      sportCode: "basketball",
      name: "National Inter-Club Basketball 2025 (Archived)",
      slug: `staging-bball-archived-${randomUUID().slice(0, 6)}`,
      status: "completed",
      archived: true,
      archivedFromStatus: "completed",
    });

    // D. ARCHIVED Badminton Knockout (Archived from Draft)
    const archivedBadminton = await createCompetitionGraph({
      organisationId: orgMetroClubId,
      sportCode: "badminton",
      name: "Invitational Badminton Masters 2025 (Archived)",
      slug: `staging-badmin-archived-${randomUUID().slice(0, 6)}`,
      status: "draft",
      archived: true,
      archivedFromStatus: "draft",
    });

    // E. Canoe Polo In-Progress (Live)
    const liveCanoePolo = await createCompetitionGraph({
      organisationId: orgNationalFedId,
      sportCode: "canoe_polo",
      name: "National Canoe Polo Premier 2026",
      slug: `staging-canoe-live-${randomUUID().slice(0, 6)}`,
      status: "active",
    });

    // F. Badminton Friendly (Draft)
    const draftBadminton = await createCompetitionGraph({
      organisationId: orgMetroClubId,
      sportCode: "badminton",
      name: "Marina Bay Badminton Open 2026",
      slug: `staging-badmin-draft-${randomUUID().slice(0, 6)}`,
      status: "draft",
    });

    // 5. Seed Realistic Match Score Streams & Canonical Events
    log("[4/6] Seeding match score streams and canonical scoring events...");
    const matchesToScore = await sql<
      { id: string; competition_id: string; division_id: string; sport_code: SportId }[]
    >`
      SELECT m.id, m.competition_id, m.division_id, c.sport_code
      FROM matches m
      JOIN competitions c ON c.id = m.competition_id
      WHERE m.competition_id IN (${activeVball.competitionId}, ${completedTableTennis.competitionId})
      LIMIT 4;
    `;

    for (const match of matchesToScore) {
      const pack = SPORT_PACKS[match.sport_code];
      const settingsSnapshot = { sport_id: match.sport_code, regular_target: 25 };
      const [settingsHash] = await sql<
        { hash: string }[]
      >`SELECT phase4_sha256_json(${sql.json(settingsSnapshot)}) AS hash`;

      await sql`
        INSERT INTO match_score_streams (
          match_id, competition_id, division_id, sport_code, pack_version,
          settings_snapshot, settings_fingerprint, current_version
        ) VALUES (
          ${match.id}, ${match.competition_id}, ${match.division_id}, ${match.sport_code}, ${pack.version},
          ${sql.json(settingsSnapshot)}, ${settingsHash!.hash}, 2
        )
        ON CONFLICT (match_id, competition_id, division_id) DO NOTHING;
      `;

      const clientEventId1 = randomUUID();
      const clientEventId2 = randomUUID();
      const command1 = { kind: "point", team: "home", delta: 1 };
      const command2 = { kind: "point", team: "away", delta: 1 };
      const [cmdHash1] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(command1)}) AS hash`;
      const [cmdHash2] = await sql<{ hash: string }[]>`SELECT phase4_sha256_json(${sql.json(command2)}) AS hash`;

      await sql`
        INSERT INTO canonical_score_events (
          match_id, competition_id, division_id, client_event_id, aggregate_version, sequence,
          event_type, command, command_fingerprint, actor_account_id, device_timestamp
        ) VALUES
          (${match.id}, ${match.competition_id}, ${match.division_id}, ${clientEventId1}, 1, 1,
           'point', ${sql.json(command1)}, ${cmdHash1!.hash}, ${organiserAccountId}, now() - interval '10 minutes'),
          (${match.id}, ${match.competition_id}, ${match.division_id}, ${clientEventId2}, 2, 2,
           'point', ${sql.json(command2)}, ${cmdHash2!.hash}, ${organiserAccountId}, now() - interval '5 minutes')
        ON CONFLICT DO NOTHING;
      `;
    }

    // 6. Verify Database Invariants (Scoped ONLY to records created by this run)
    log("[5/6] Inspecting seeded replica invariants...");
    const seededCompetitionIds = [
      activeVball.competitionId,
      completedTableTennis.competitionId,
      archivedBasketball.competitionId,
      archivedBadminton.competitionId,
      liveCanoePolo.competitionId,
      draftBadminton.competitionId,
    ];

    const stats = await sql<
      {
        total_competitions: number;
        archived_competitions: number;
        total_matches: number;
        frozen_archived_matches: number;
        distinct_sports: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM competitions WHERE id = ANY(${seededCompetitionIds})) AS total_competitions,
        (SELECT count(*)::int FROM competitions WHERE id = ANY(${seededCompetitionIds}) AND status = 'archived') AS archived_competitions,
        (SELECT count(*)::int FROM matches WHERE competition_id = ANY(${seededCompetitionIds})) AS total_matches,
        (SELECT count(*)::int FROM matches m JOIN competitions c ON c.id = m.competition_id WHERE m.competition_id = ANY(${seededCompetitionIds}) AND c.status = 'archived') AS frozen_archived_matches,
        (SELECT count(DISTINCT sport_code)::int FROM competitions WHERE id = ANY(${seededCompetitionIds})) AS distinct_sports;
    `;

    const summary = stats[0]!;
    log("[6/6] Replica Seed Verification Complete:");
    log(`  - Total Competitions:     ${summary.total_competitions}`);
    log(`  - Archived Competitions:  ${summary.archived_competitions}`);
    log(`  - Distinct Sports:        ${summary.distinct_sports}/5`);
    log(`  - Total Matches:          ${summary.total_matches}`);
    log(`  - Frozen Archived Matches: ${summary.frozen_archived_matches}`);

    if (
      summary.total_competitions !== 6 ||
      summary.archived_competitions !== 2 ||
      summary.distinct_sports !== 5 ||
      summary.total_matches !== 18 ||
      summary.frozen_archived_matches !== 6
    ) {
      throw new Error(`Staging replica seeder failed invariant expectations: ${JSON.stringify(summary)}`);
    }

    log("\n[SUCCESS] Staging production replica seeded successfully with realistic active and archived state.");
    return summary;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedStagingProductionReplica()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[FAILED] Seed staging production replica error:", err);
      process.exit(1);
    });
}
