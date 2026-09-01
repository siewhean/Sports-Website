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

  // 4. Seed 2 divisions (Men Open & Women Open, 8 teams each)
  const divisions = [
    { id: randomUUID(), name: "Men Open", teamLimit: 8 },
    { id: randomUUID(), name: "Women Open", teamLimit: 8 },
  ];

  const matchRecords: { matchId: string; divisionId: string; code: string; rawToken: string }[] = [];

  for (const div of divisions) {
    await client`
      INSERT INTO divisions (id, competition_id, name, team_limit)
      VALUES (${div.id}, ${competitionId}, ${div.name}, ${div.teamLimit});
    `;

    const formatRevId = randomUUID();
    const divMatches = Array.from({ length: 4 }, (_, i) => ({
      id: randomUUID(),
      code: `${div.name === "Men Open" ? "M" : "W"}${i + 1}`,
      ordinal: i + 1,
    }));

    const graph = {
      id: formatRevId,
      schemaVersion: 1,
      entryCount: 8,
      stages: [
        {
          id: "group-stage",
          label: "Group Stage",
          kind: "single_elimination",
          order: 1,
          groupIds: [],
          groupSize: null,
          outputRanks: 2,
          matchIds: divMatches.map((m) => m.id),
        },
      ],
      matches: divMatches.map((m, i) => ({
        id: m.id,
        stageId: "group-stage",
        round: 1,
        order: m.ordinal,
        purpose: "championship",
        home: { type: "entry_seed", seed: i * 2 + 1 },
        away: { type: "entry_seed", seed: i * 2 + 2 },
      })),
      terminalMatchIds: [divMatches[divMatches.length - 1]!.id],
    };
    const defHash = canonicalHash(graph);

    await client`
      INSERT INTO format_revisions (
        id, competition_id, division_id, revision, definition, definition_hash, status, created_by
      ) VALUES (
        ${formatRevId}, ${competitionId}, ${div.id}, 1, ${client.json(graph)}, ${defHash}, 'published', ${userId}
      );
    `;

    for (let i = 1; i <= 8; i++) {
      await client`
        INSERT INTO division_entries (id, division_id, name, seed, status)
        VALUES (${randomUUID()}, ${div.id}, ${`${div.name} Team ${i}`}, ${i}, 'confirmed');
      `;
    }

    for (const m of divMatches) {
      await client`
        INSERT INTO matches (
          id, competition_id, division_id, format_revision_id, code, stage, round_number, ordinal, state
        ) VALUES (
          ${m.id}, ${competitionId}, ${div.id}, ${formatRevId}, ${m.code}, 'group', 1, ${m.ordinal}, 'ready'
        );
      `;

      const passId = randomUUID();
      const rawSecret = randomBytes(24).toString("hex"); // 48-char raw secret
      const secretHash = createHash("sha256").update(rawSecret).digest();

      await client`
        INSERT INTO scoring_access_passes (
          id, competition_id, match_id, secret_hash, expires_at, created_by, role, scope
        ) VALUES (
          ${passId}, ${competitionId}, ${m.id}, ${secretHash}, now() + interval '7 days',
          ${userId}, 'scorekeeper', '["score:read","score:write","score:reverse","score:finalise"]'::jsonb
        );
      `;

      matchRecords.push({
        matchId: m.id,
        divisionId: div.id,
        code: m.code,
        rawToken: rawSecret,
      });
    }
  }

  // 5. Seed playing areas (Courts)
  const court1Id = randomUUID();
  const court2Id = randomUUID();
  await client`
    INSERT INTO playing_areas (id, competition_id, name, ordinal)
    VALUES
      (${court1Id}, ${competitionId}, 'Court 1', 1),
      (${court2Id}, ${competitionId}, 'Court 2', 2);
  `;

  // 6. Seed schedule revision and scheduled matches
  const scheduleRevId = randomUUID();
  const firstFormatRevId = (
    await client<{ id: string }[]>`SELECT id FROM format_revisions WHERE competition_id = ${competitionId} LIMIT 1`
  )[0]!.id;
  const inputHash = canonicalHash({ competitionId, matchCount: matchRecords.length });

  await client`
    INSERT INTO schedule_revisions (
      id, competition_id, format_revision_id, revision, input_hash, status, created_by
    ) VALUES (
      ${scheduleRevId}, ${competitionId}, ${firstFormatRevId}, 1, ${inputHash}, 'published', ${userId}
    );
  `;

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

  // 7. Seed competition publication record linking the published schedule revision
  await client`
    INSERT INTO competition_publications (
      id, competition_id, published_by, revision, published_schedule_revision_id, projection_version, status, published_at
    ) VALUES (
      ${randomUUID()}, ${competitionId}, ${userId}, 1, ${scheduleRevId}, 1, 'published', now()
    ) ON CONFLICT (competition_id) DO UPDATE SET
      revision = competition_publications.revision + 1,
      published_schedule_revision_id = ${scheduleRevId},
      published_at = now();
  `;

  await client.end({ timeout: 2 });

  const artifactDir = path.join(root, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const seedFixturePath = path.join(artifactDir, "staging-pilot-seed.json");

  const payload = {
    target_url: targetUrl,
    organisation_id: orgId,
    organisation_owner_id: userId,
    competition_id: competitionId,
    competition_slug: compSlug,
    sport_code: "volleyball",
    divisions: divisions.map((d) => ({ id: d.id, name: d.name })),
    matches: matchRecords,
    seeded_at: new Date().toISOString(),
  };

  await writeFile(seedFixturePath, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✓ Staging pilot fixture seeded successfully!`);
  console.log(`  Competition ID: ${competitionId}`);
  console.log(`  Slug:           ${compSlug}`);
  console.log(`  Divisions:      2 (${divisions.map((d) => d.name).join(", ")})`);
  console.log(`  Matches:        ${matchRecords.length} ready matches`);
  console.log(`  Fixture saved:  ${seedFixturePath}\n`);
}

main().catch((err) => {
  console.error("❌ Failed to seed staging pilot fixture:", err);
  process.exit(1);
});
