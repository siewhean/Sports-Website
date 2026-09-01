/**
 * seed-staging-pilot.ts
 *
 * Provisions a complete multi-division competition fixture onto the target
 * database / staging environment for Gate D qualification and load benchmarking.
 *
 * Generates: artifacts/staging-pilot-seed.json
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SPORT_PACKS } from "../packages/domain/src/index.js";
import { phase3DomainAdapter } from "../apps/api/src/phase-3-domain-adapter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const targetUrl = process.env.TARGET_URL ?? "http://127.0.0.1:4101";

function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" Seeding Staging Pilot Fixture for Gate D Load Benchmarking");
  console.log(` Target Database: ${databaseUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(` Target API URL:  ${targetUrl}`);
  console.log("════════════════════════════════════════════════════════════\n");

  const client = postgres(databaseUrl, {
    max: 5,
    onnotice: () => undefined,
  });

  const orgId = randomUUID();
  const userId = randomUUID();
  const competitionId = randomUUID();
  const compSlug = `pilot-vball-${Date.now()}`;

  // 1. Seed active sport packs
  for (const [sportId, pack] of Object.entries(SPORT_PACKS)) {
    const hash = phase3DomainAdapter.hash(pack);
    await client`
      INSERT INTO sport_pack_versions (
        sport_code, version, schema_version, definition, definition_hash, status, revision, activated_at
      ) VALUES (
        ${sportId}, ${pack.version}, 1, ${client.json(pack)}, ${hash}, 'active', 1, now()
      ) ON CONFLICT (sport_code, version) DO UPDATE SET
        status = 'active',
        activated_at = now();
    `;
  }

  // 2. Seed account, organisation & owner
  await client`
    INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
    VALUES (${userId}, 'pilot-organiser@matchday.test', 'Pilot Organiser', now())
    ON CONFLICT (id) DO NOTHING;
  `;

  await client.begin(async (tx) => {
    await tx`
      INSERT INTO organisations (id, name, slug)
      VALUES (${orgId}, 'National Volleyball League', ${`nvl-${randomUUID().slice(0, 8)}`});
    `;
    await tx`
      INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
      VALUES (${orgId}, ${userId}, 'owner', 'active');
    `;
  });

  // 3. Seed competition
  await client`
    INSERT INTO competitions (
      id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, venue, address, country_code, locale
    ) VALUES (
      ${competitionId}, ${orgId}, ${userId}, 'National Volleyball Championship 2026',
      ${compSlug}, 'volleyball', 'Asia/Singapore', '2026-09-01', '2026-09-02',
      'Singapore Indoor Stadium', '2 Stadium Walk', 'SG', 'en-SG'
    );
  `;

  // 4. Seed playing areas (Courts) with valid sort_order and slot_minutes
  const court1Id = randomUUID();
  const court2Id = randomUUID();
  await client`
    INSERT INTO playing_areas (id, competition_id, name, sort_order, slot_minutes, fixed_reserve_slots)
    VALUES
      (${court1Id}, ${competitionId}, 'Court 1', 1, 45, 0),
      (${court2Id}, ${competitionId}, 'Court 2', 2, 45, 0);
  `;

  // 5. Seed 2 divisions (Men Open & Women Open, 8 teams each)
  const divisions = [
    { id: randomUUID(), name: "Men Open", teamLimit: 8 },
    { id: randomUUID(), name: "Women Open", teamLimit: 8 },
  ];

  const matchRecords: { matchId: string; divisionId: string; passToken: string }[] = [];
  const formatRevisionIds: string[] = [];

  for (let divIdx = 0; divIdx < divisions.length; divIdx++) {
    const div = divisions[divIdx]!;

    await client`
      INSERT INTO divisions (id, competition_id, name, team_limit)
      VALUES (${div.id}, ${competitionId}, ${div.name}, ${div.teamLimit});
    `;

    // Seed division sport settings
    await client`
      INSERT INTO division_sport_settings (
        id, competition_id, division_id, sport_code, settings, schema_version
      ) VALUES (
        ${randomUUID()}, ${competitionId}, ${div.id}, 'volleyball',
        ${client.json({ setsToWin: 3, pointsPerSet: 25, finalSetPoints: 15, deuceMargin: 2 })},
        1
      );
    `;

    // Seed 8 team entries
    const entryIds: string[] = [];
    for (let t = 1; t <= 8; t++) {
      const entryId = randomUUID();
      entryIds.push(entryId);
      await client`
        INSERT INTO division_entries (id, competition_id, division_id, name, seed, status)
        VALUES (${entryId}, ${competitionId}, ${div.id}, ${`${div.name} Team ${t}`}, ${t}, 'active');
      `;
    }

    // Build format definition for single-elimination 8-team bracket
    const formatRevId = randomUUID();
    formatRevisionIds.push(formatRevId);

    const divMatchIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const formatDef = {
      id: formatRevId,
      schemaVersion: 1,
      entryCount: 8,
      stages: [
        {
          id: "semi-finals",
          label: "Semi-Finals",
          kind: "single_elimination",
          order: 1,
          groupIds: [],
          groupSize: null,
          outputRanks: 4,
          matchIds: [divMatchIds[0], divMatchIds[1]],
        },
        {
          id: "finals",
          label: "Finals",
          kind: "single_elimination",
          order: 2,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: [divMatchIds[2], divMatchIds[3]],
        },
      ],
      matches: [
        {
          id: divMatchIds[0],
          stageId: "semi-finals",
          round: 1,
          order: 1,
          purpose: "semifinal",
          home: { type: "entry_seed", seed: 1 },
          away: { type: "entry_seed", seed: 4 },
        },
        {
          id: divMatchIds[1],
          stageId: "semi-finals",
          round: 1,
          order: 2,
          purpose: "semifinal",
          home: { type: "entry_seed", seed: 2 },
          away: { type: "entry_seed", seed: 3 },
        },
        {
          id: divMatchIds[2],
          stageId: "finals",
          round: 2,
          order: 1,
          purpose: "championship",
          home: { type: "match_winner", matchId: divMatchIds[0] },
          away: { type: "match_winner", matchId: divMatchIds[1] },
        },
        {
          id: divMatchIds[3],
          stageId: "finals",
          round: 2,
          order: 2,
          purpose: "third_place",
          home: { type: "match_loser", matchId: divMatchIds[0] },
          away: { type: "match_loser", matchId: divMatchIds[1] },
        },
      ],
      terminalMatchIds: [divMatchIds[2]],
    };

    const defHash = phase3DomainAdapter.hash(formatDef);

    await client`
      INSERT INTO format_revisions (
        id, competition_id, division_id, revision, definition, definition_hash, status, created_by
      ) VALUES (
        ${formatRevId}, ${competitionId}, ${div.id}, 1, ${client.json(formatDef)}, ${defHash}, 'draft', ${userId}
      );
    `;

    // Seed format validation evidence
    await client`
      INSERT INTO format_validation_evidence (
        id, format_revision_id, definition_hash, valid, graph_acyclic, graph_reachable,
        slots_unambiguous, deterministic_match_count, available_match_slots, required_match_slots,
        recommendation_fits_capacity, issues, validated_at, validated_by
      ) VALUES (
        ${randomUUID()}, ${formatRevId}, ${defHash}, true, true, true,
        true, 4, 10, 4, true, '[]'::jsonb, now(), ${userId}
      );
    `;

    // Seed matches in 'ready' state
    for (let mIdx = 0; mIdx < divMatchIds.length; mIdx++) {
      const mId = divMatchIds[mIdx]!;
      await client`
        INSERT INTO matches (
          id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal, state
        ) VALUES (
          ${mId}, ${competitionId}, ${div.id}, ${formatRevId},
          ${`D${divIdx + 1}-M${mIdx + 1}`},
          ${mIdx < 2 ? "semi-finals" : "finals"},
          ${mIdx < 2 ? 1 : 2},
          ${mIdx + 1},
          'ready'
        );
      `;

      // Generate authentic 24-byte random scoring pass secret
      const rawSecret = randomBytes(24).toString("hex");
      const secretHash = createHash("sha256").update(rawSecret).digest();

      await client`
        INSERT INTO scoring_access_passes (
          id, competition_id, match_id, secret_hash, expires_at, created_by, role, scope
        ) VALUES (
          ${randomUUID()}, ${competitionId}, ${mId}, ${secretHash},
          now() + interval '7 days', ${userId}, 'scorekeeper',
          '["score:read","score:write","score:reverse","score:finalise"]'::jsonb
        );
      `;

      matchRecords.push({ matchId: mId, divisionId: div.id, passToken: rawSecret });
    }
  }

  // 6. Seed schedule revision containing both divisions
  const scheduleRevId = randomUUID();
  const inputHash = canonicalHash({ competitionId, matchCount: matchRecords.length });

  await client`
    INSERT INTO schedule_revisions (
      id, competition_id, format_revision_id, revision, input_hash, status, created_by
    ) VALUES (
      ${scheduleRevId}, ${competitionId}, ${formatRevisionIds[0]!}, 1, ${inputHash}, 'published', ${userId}
    );
  `;

  // 7. Seed schedule_revision_formats for both divisions
  for (let divIdx = 0; divIdx < divisions.length; divIdx++) {
    await client`
      INSERT INTO schedule_revision_formats (
        schedule_revision_id, competition_id, division_id, format_revision_id
      ) VALUES (
        ${scheduleRevId}, ${competitionId}, ${divisions[divIdx]!.id}, ${formatRevisionIds[divIdx]!}
      );
    `;
  }

  // 8. Seed scheduled matches with court assignments and time slots
  const baseStartTime = new Date("2026-09-01T09:00:00.000Z");
  for (let i = 0; i < matchRecords.length; i++) {
    const m = matchRecords[i]!;
    const areaId = i % 2 === 0 ? court1Id : court2Id;
    const matchStart = new Date(baseStartTime.getTime() + Math.floor(i / 2) * 60 * 60 * 1000);
    const matchEnd = new Date(matchStart.getTime() + 45 * 60 * 1000);

    await client`
      INSERT INTO scheduled_matches (
        schedule_revision_id, match_id, competition_id, playing_area_id, starts_at, ends_at
      ) VALUES (
        ${scheduleRevId}, ${m.matchId}, ${competitionId}, ${areaId}, ${matchStart.toISOString()}, ${matchEnd.toISOString()}
      );
    `;
  }

  // 9. Seed competition publication record linking the published schedule revision
  await client`
    INSERT INTO competition_publications (
      competition_id, published_schedule_revision_id, schedule_version, schedule_published_at, updated_at
    ) VALUES (
      ${competitionId}, ${scheduleRevId}, 1, now(), now()
    ) ON CONFLICT (competition_id) DO UPDATE SET
      schedule_version = competition_publications.schedule_version + 1,
      published_schedule_revision_id = ${scheduleRevId},
      schedule_published_at = now(),
      updated_at = now();
  `;

  console.log(`✓ Competition seeded: ${competitionId} (Slug: ${compSlug})`);
  console.log(`✓ Divisions seeded:    ${divisions.length} (8 teams each)`);
  console.log(`✓ Matches seeded:      ${matchRecords.length} with scheduled courts & timeslots`);
  console.log(`✓ Scoring passes:      ${matchRecords.length} active scorekeeper passes`);

  // 10. Post-seed database & API verification
  console.log("\nExecuting post-seed verification checks...");

  const divCheck = await client`SELECT count(*)::int as count FROM divisions WHERE competition_id = ${competitionId};`;
  if (divCheck[0]!.count !== 2) {
    throw new Error(`Post-seed validation failed: Expected 2 divisions, found ${divCheck[0]!.count}`);
  }

  const matchCheck =
    await client`SELECT count(*)::int as count FROM scheduled_matches WHERE schedule_revision_id = ${scheduleRevId};`;
  if (matchCheck[0]!.count !== matchRecords.length) {
    throw new Error(
      `Post-seed validation failed: Expected ${matchRecords.length} scheduled matches, found ${matchCheck[0]!.count}`,
    );
  }

  const pubCheck =
    await client`SELECT published_schedule_revision_id FROM competition_publications WHERE competition_id = ${competitionId};`;
  if (pubCheck[0]?.published_schedule_revision_id !== scheduleRevId) {
    throw new Error(
      `Post-seed validation failed: Competition publication does not point to schedule revision ${scheduleRevId}`,
    );
  }

  console.log("✓ Database verification passed.");

  // Output JSON artifact
  const outputData = {
    generated_at_utc: new Date().toISOString(),
    target_url: targetUrl,
    database_url: databaseUrl.replace(/:[^:@]+@/, ":***@"),
    organisation_id: orgId,
    competition_id: competitionId,
    competition_slug: compSlug,
    public_competition_url: `${targetUrl}/api/v1/public/competitions/${competitionId}`,
    public_schedule_url: `${targetUrl}/api/v1/public/competitions/${competitionId}/schedule`,
    divisions: divisions.map((d) => ({ id: d.id, name: d.name })),
    scoreable_matches: matchRecords.map((m) => ({
      match_id: m.matchId,
      division_id: m.divisionId,
      pass_token: m.passToken,
    })),
  };

  const artifactDir = path.join(root, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const seedFile = path.join(artifactDir, "staging-pilot-seed.json");
  await writeFile(seedFile, JSON.stringify(outputData, null, 2), "utf8");

  console.log(`✓ Exported staging seed state to: ${seedFile}\n`);
  await client.end({ timeout: 2 });
}

main().catch((err) => {
  console.error("❌ Staging Pilot Seeder failed:", err);
  process.exit(1);
});
