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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";

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

export async function seedStagingProductionReplica(options: { databaseUrl?: string; verbose?: boolean } = {}) {
  const url = options.databaseUrl ?? databaseUrl;
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

    // 3. Helper to create competition with divisions, entries, and materialised format
    const createCompetitionGraph = async (params: {
      organisationId: string;
      sportCode: SportId;
      name: string;
      slug: string;
      status: "draft" | "published" | "active" | "completed";
      archived?: boolean;
      archivedFromStatus?: string;
    }) => {
      const compId = randomUUID();
      const divId = randomUUID();
      const formatRevId = randomUUID();

      await sql`
        INSERT INTO competitions (
          id, organisation_id, created_by, name, slug, sport_code,
          timezone, starts_on, ends_on, venue, address, country_code, locale, plan_tier, status
        ) VALUES (
          ${compId}, ${params.organisationId}, ${organiserAccountId}, ${params.name}, ${params.slug},
          ${params.sportCode}, 'Asia/Singapore', '2026-09-01', '2026-09-05',
          'Singapore Sports Hub', '1 Stadium Drive', 'SG', 'en-SG', 'organiser_pro', 'draft'
        );
      `;

      const pack = SPORT_PACKS[params.sportCode];
      await sql`
        INSERT INTO competition_sport_settings (
          competition_id, updated_by, sport_code, pack_version, pack_schema_version,
          recommended_snapshot, settings_override
        ) VALUES (
          ${compId}, ${organiserAccountId}, ${params.sportCode}, ${pack.version}, ${pack.schemaVersion},
          '{}'::jsonb, '{}'::jsonb
        );
      `;

      await sql`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES (${divId}, ${compId}, 'Open Championship', 8);
      `;

      // 4 Entries
      for (let i = 0; i < 4; i++) {
        const entryId = randomUUID();
        await sql`
          INSERT INTO division_entries (id, division_id, name, seed, entry_type, status)
          VALUES (${entryId}, ${divId}, ${`Seed Team ${i + 1}`}, ${i + 1}, 'team', 'confirmed');
        `;
      }

      // 4-entry Single Elimination Graph
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

      // Transition competition lifecycle to target status
      if (params.status === "published" || params.status === "active" || params.status === "completed") {
        await sql`UPDATE competitions SET status = 'ready' WHERE id = ${compId};`;
        await sql`UPDATE competitions SET status = 'published' WHERE id = ${compId};`;
        if (params.status === "active" || params.status === "completed") {
          await sql`UPDATE competitions SET status = 'live' WHERE id = ${compId};`;
          if (params.status === "completed") {
            await sql`UPDATE competitions SET status = 'completed' WHERE id = ${compId};`;
          }
        }
      }

      // If requested, archive the competition
      if (params.archived) {
        const priorStatus = params.archivedFromStatus ?? params.status;
        await sql`
          UPDATE competitions
          SET status = 'archived',
              archived_from_status = ${priorStatus},
              archived_at = now()
          WHERE id = ${compId};
        `;
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

    // 6. Verify Database Invariants
    log("[5/6] Inspecting seeded replica invariants...");
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
        (SELECT count(*)::int FROM competitions) AS total_competitions,
        (SELECT count(*)::int FROM competitions WHERE status = 'archived') AS archived_competitions,
        (SELECT count(*)::int FROM matches) AS total_matches,
        (SELECT count(*)::int FROM matches m JOIN competitions c ON c.id = m.competition_id WHERE c.status = 'archived') AS frozen_archived_matches,
        (SELECT count(DISTINCT sport_code)::int FROM competitions) AS distinct_sports;
    `;

    const summary = stats[0]!;
    log("[6/6] Replica Seed Verification Complete:");
    log(`  - Total Competitions:     ${summary.total_competitions}`);
    log(`  - Archived Competitions:  ${summary.archived_competitions}`);
    log(`  - Distinct Sports:        ${summary.distinct_sports}/5`);
    log(`  - Total Matches:          ${summary.total_matches}`);
    log(`  - Frozen Archived Matches: ${summary.frozen_archived_matches}`);

    if (summary.archived_competitions < 2 || summary.frozen_archived_matches < 6 || summary.distinct_sports < 5) {
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
