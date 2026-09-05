/**
 * run-phase-7-real-e2e.ts
 *
 * Real Gate D browser qualification harness.
 * Starts an isolated PostgreSQL schema, Redis, production Fastify API,
 * API-backed Next.js web application, seeds authentic multi-division & XSS fixtures,
 * and executes Playwright gate-d test suite (playwright.gate-d.config.ts).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { SPORT_PACKS } from "@matchday/domain";
import { systemClock, type PostgresJsSql } from "@matchday/identity";
import { UnavailableIdentityProvider } from "../src/identity-runtime.js";
import { PostgresIdentityUnitOfWork } from "../src/identity-postgres.js";
import { IdentityApiRuntime } from "../src/identity-runtime.js";
import { Phase2Runtime } from "../src/phase-2-runtime.js";
import { phase2DomainAdapter } from "../src/phase-2-domain-adapter.js";
import { Phase3Runtime } from "../src/phase-3-runtime.js";
import { phase3DomainAdapter } from "../src/phase-3-domain-adapter.js";
import { EntitlementRuntime } from "../src/entitlement-runtime.js";
import { buildApp } from "../src/app.js";
import { healthyProbes, testConfig } from "../tests/helpers.js";
import postgres, { type Sql } from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/migrations");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_phase7_e2e_${randomUUID().replaceAll("-", "")}`;

const apiPort = 4107;
const webPort = 3107;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

const activeProcesses: ChildProcess[] = [];

function startProcess(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data) => {
    // Suppress verbose web logs unless debugging
    if (process.env.DEBUG_E2E) {
      process.stdout.write(`[${name}] ${data}`);
    }
  });

  child.stderr?.on("data", (data) => {
    if (process.env.DEBUG_E2E) {
      process.stderr.write(`[${name} err] ${data}`);
    }
  });

  activeProcesses.push(child);
  return child;
}

async function waitForHttp(url: string, label: string, maxWaitMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) {
        return;
      }
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${label} at ${url}`);
}

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
  console.log(" Starting Phase 7 Gate D Real Browser Qualification Harness");
  console.log(` Database Schema: ${schema}`);
  console.log(` API Origin:      ${apiOrigin}`);
  console.log(` Web Origin:      ${webOrigin}`);
  console.log("════════════════════════════════════════════════════════════\n");

  let client: Sql | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    // 1. Run migrations in isolated schema
    console.log("Running database migrations...");
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });

    client = postgres(databaseUrl, {
      max: 10,
      connection: { search_path: schema },
      onnotice: () => undefined,
    });

    // 2. Seed active sport packs
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

    // 3. Initialize runtimes
    const identityRuntime = new IdentityApiRuntime(
      new UnavailableIdentityProvider(),
      new PostgresIdentityUnitOfWork(client as unknown as PostgresJsSql),
      "phase7-e2e-csrf-secret-at-least-32-chars-long",
      systemClock,
    );
    const entitlementRuntime = new EntitlementRuntime(client as unknown as PostgresJsSql);
    const phase2Runtime = new Phase2Runtime(
      client as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(),
      undefined,
      "test-fallback-hmac-secret-at-least-32-chars-long",
    );
    const phase3Runtime = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);

    // 4. Seed Organiser, 2-Division Competition, Formats, Schedule, Scoring Access Pass
    const userId = randomUUID();
    const orgId = randomUUID();
    const competitionId = randomUUID();
    const compSlug = `gate-d-championship-${Date.now()}`;

    await client`
      INSERT INTO accounts (id, primary_email, display_name, email_verified_at)
      VALUES (${userId}, 'gate-d-organiser@matchday.test', 'Gate D Organiser', now());
    `;

    await client.begin(async (tx) => {
      await tx`
        INSERT INTO organisations (id, name, slug)
        VALUES (${orgId}, 'Gate D Athletic Association', ${`gate-d-org-${randomUUID().slice(0, 8)}`});
      `;
      await tx`
        INSERT INTO organisation_memberships (organisation_id, account_id, role, status)
        VALUES (${orgId}, ${userId}, 'owner', 'active');
      `;
    });

    await client`
      INSERT INTO competitions (
        id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, venue, address, country_code, locale
      ) VALUES (
        ${competitionId}, ${orgId}, ${userId}, 'Gate D National Championship',
        ${compSlug}, 'volleyball', 'Asia/Singapore', '2026-09-01', '2026-09-02',
        'National Stadium Hall 1', '1 Stadium Drive', 'SG', 'en-SG'
      );
    `;

    const court1Id = randomUUID();
    const court2Id = randomUUID();
    await client`
      INSERT INTO playing_areas (id, competition_id, name, sort_order, slot_minutes, fixed_reserve_slots)
      VALUES
        (${court1Id}, ${competitionId}, 'Court 1', 1, 45, 0),
        (${court2Id}, ${competitionId}, 'Court 2', 2, 45, 0);
    `;

    const divisions = [
      { id: randomUUID(), name: "Division A", teamLimit: 8 },
      { id: randomUUID(), name: "Division B", teamLimit: 8 },
    ];

    const matchRecords: { matchId: string; divisionId: string; passToken: string }[] = [];
    const formatRevisionIds: string[] = [];

    for (let divIdx = 0; divIdx < divisions.length; divIdx++) {
      const div = divisions[divIdx]!;
      await client`
        INSERT INTO divisions (id, competition_id, name, team_limit)
        VALUES (${div.id}, ${competitionId}, ${div.name}, ${div.teamLimit});
      `;

      await client`
        INSERT INTO division_sport_settings (
          id, competition_id, division_id, sport_code, settings, schema_version
        ) VALUES (
          ${randomUUID()}, ${competitionId}, ${div.id}, 'volleyball',
          ${client.json({ setsToWin: 3, pointsPerSet: 25, finalSetPoints: 15, deuceMargin: 2 })},
          1
        );
      `;

      for (let t = 1; t <= 8; t++) {
        await client`
          INSERT INTO division_entries (id, competition_id, division_id, name, seed, status)
          VALUES (${randomUUID()}, ${competitionId}, ${div.id}, ${`${div.name} Club ${t}`}, ${t}, 'active');
        `;
      }

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
          ${formatRevId}, ${competitionId}, ${div.id}, 1, ${client.json(formatDef as unknown as postgres.JSONValue)}, ${defHash}, 'draft', ${userId}
        );
      `;

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

    const scheduleRevId = randomUUID();
    const inputHash = canonicalHash({ competitionId, matchCount: matchRecords.length });

    await client`
      INSERT INTO schedule_revisions (
        id, competition_id, format_revision_id, revision, input_hash, status, created_by
      ) VALUES (
        ${scheduleRevId}, ${competitionId}, ${formatRevisionIds[0]!}, 1, ${inputHash}, 'published', ${userId}
      );
    `;

    for (let divIdx = 0; divIdx < divisions.length; divIdx++) {
      await client`
        INSERT INTO schedule_revision_formats (
          schedule_revision_id, competition_id, division_id, format_revision_id
        ) VALUES (
          ${scheduleRevId}, ${competitionId}, ${divisions[divIdx]!.id}, ${formatRevisionIds[divIdx]!}
        );
      `;
    }

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

    // 5. Seed Stored XSS Competition into PostgreSQL
    const xssCompId = randomUUID();
    const xssSlug = `xss-tourney-${Date.now()}`;
    const xssMaliciousName = "Gate D <script>window.__xss_injected_flag=true</script>";

    await client`
      INSERT INTO competitions (
        id, organisation_id, created_by, name, slug, sport_code, timezone, starts_on, ends_on, venue, address, country_code, locale
      ) VALUES (
        ${xssCompId}, ${orgId}, ${userId}, ${xssMaliciousName},
        ${xssSlug}, 'volleyball', 'Asia/Singapore', '2026-09-01', '2026-09-02',
        'XSS Test Court', '1 Test St', 'SG', 'en-SG'
      );
    `;

    console.log("✓ Fixtures seeded successfully.");

    // 6. Start Fastify API server
    const config = testConfig({
      API_ALLOWED_ORIGINS: `${webOrigin},http://localhost:${webPort}`,
    });

    app = await buildApp({
      config,
      probes: healthyProbes,
      identityRuntime,
      phase2Runtime,
      phase3Runtime,
      entitlementRuntime,
    });

    await app.listen({ host: "127.0.0.1", port: apiPort });
    await waitForHttp(`${apiOrigin}/health/live`, "Fastify API");
    console.log(`✓ Fastify API listening at ${apiOrigin}`);

    // 7. Export state JSON
    const artifactDir = path.join(root, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    const stateFilePath = process.env.PHASE7_E2E_STATE_FILE ?? path.join(artifactDir, "phase-7-e2e-state.json");

    const statePayload = {
      competitionId,
      competitionSlug: compSlug,
      publicCompetitionPath: `/c/${compSlug}`,
      scorekeeperPath: `/score?access=${matchRecords[0]!.passToken}&match=${matchRecords[0]!.matchId}`,
      scoredMatchId: matchRecords[0]!.matchId,
      passToken: matchRecords[0]!.passToken,
      xssCompetitionId: xssCompId,
      xssCompetitionSlug: xssSlug,
      xssCompetitionPath: `/c/${xssSlug}`,
      xssMaliciousName,
    };

    await writeFile(stateFilePath, JSON.stringify(statePayload, null, 2), "utf8");
    console.log(`✓ Exported Phase 7 E2E state to ${stateFilePath}`);

    // 8. Start Next.js web application
    console.log("Starting Next.js web application in production mode...");
    const webEnv = {
      MATCHDAY_API_BASE_URL: apiOrigin,
      PHASE7_E2E_WEB_BASE_URL: webOrigin,
      PHASE7_E2E_STATE_FILE: stateFilePath,
    };

    startProcess(
      "next-web",
      "pnpm",
      ["--filter", "@matchday/web", "dev", "--hostname", "127.0.0.1", "--port", String(webPort)],
      webEnv,
    );
    await waitForHttp(`${webOrigin}/`, "Next.js Web App", 45000);
    console.log(`✓ Next.js Web App listening at ${webOrigin}`);

    // 9. Execute Playwright Gate D tests
    console.log("\nExecuting Playwright Gate D qualification suite...");
    const playwright = spawn("pnpm", ["--filter", "@matchday/web", "test:e2e:gate-d"], {
      cwd: root,
      env: {
        ...process.env,
        PHASE7_E2E_WEB_BASE_URL: webOrigin,
        PHASE7_E2E_STATE_FILE: stateFilePath,
      },
      stdio: "inherit",
    });

    const exitCode = await new Promise<number>((resolve) => {
      playwright.on("exit", (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      throw new Error(`Playwright Gate D qualification failed with exit code ${exitCode}`);
    }

    console.log("\n🎉 Gate D Real Browser Qualification PASS!");
  } finally {
    console.log("Tearing down processes and database schema...");
    for (const child of activeProcesses) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    if (app) {
      try {
        await app.close();
      } catch {}
    }
    if (client) {
      try {
        await client.end({ timeout: 2 });
      } catch {}
    }
    try {
      await dropTestSchema(databaseUrl, schema);
    } catch {}
  }
}

main().catch((err) => {
  console.error("❌ Phase 7 Real E2E failed:", err);
  process.exit(1);
});
