import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  calculateCalendarCapacity,
  resolveCalendarCapacityWindows,
  type CalendarCapacityInput,
} from "../../../domain/src/capacity.js";
import { dropTestSchema, migrationAdvisoryLockId } from "../../src/migrations.js";

const infra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

infra("0076 daily court reserve upgrade", () => {
  it("preserves archived fields and legacy hashes through transactional rollback and forward application", async () => {
    const schema = `test_daily_upgrade_${randomUUID().replaceAll("-", "")}`;
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined, connection: { search_path: schema } });
    try {
      await sql.unsafe(`CREATE SCHEMA "${schema}"`);
      await sql.unsafe(`SET search_path TO "${schema}", public`);
      await sql`SELECT pg_advisory_lock(${migrationAdvisoryLockId})`;
      try {
        for (const name of (await readdir(migrationsDirectory))
          .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < "0076_")
          .sort()) {
          const contents = await readFile(path.join(migrationsDirectory, name), "utf8");
          await sql.begin((tx) => tx.unsafe(contents));
        }
      } finally {
        await sql`SELECT pg_advisory_unlock(${migrationAdvisoryLockId})`;
      }
      const account = randomUUID(),
        organisation = randomUUID(),
        archived = randomUUID(),
        active = randomUUID();
      await sql`INSERT INTO accounts (id,primary_email,display_name) VALUES (${account},${`${account}@example.test`},'Migration fixture')`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO organisations (id,name,slug) VALUES (${organisation},'Migration fixture',${`daily-${organisation}`})`;
        await tx`INSERT INTO organisation_memberships (organisation_id,account_id,role,status) VALUES (${organisation},${account},'owner','active')`;
      });
      for (const id of [archived, active]) {
        await sql`INSERT INTO competitions (id,organisation_id,created_by,name,slug,sport_code,timezone,starts_on,ends_on)
          VALUES (${id},${organisation},${account},'Daily fixture',${`daily-${id}`},'badminton','Europe/London','2027-10-30','2027-10-31')`;
        await sql`INSERT INTO playing_areas (competition_id,name,slot_minutes,fixed_reserve_slots) VALUES (${id},'Legacy Court',30,2)`;
      }
      await sql`UPDATE competitions SET status='archived',archived_from_status=status WHERE id=${archived}`;
      const before = await sql`SELECT to_jsonb(a) AS original FROM playing_areas a WHERE competition_id=${archived}`;
      const legacyHash = (await sql<{ hash: string }[]>`SELECT phase4_capacity_hash(${archived}) AS hash`)[0]!.hash;
      const migration = await readFile(path.join(migrationsDirectory, "0076_daily_court_reserves.sql"), "utf8");
      // There is no repository down-migration facility. Verify DDL rollback,
      // then forward application; do not pretend this is a production downgrade.
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(migration);
          throw new Error("disposable rollback probe");
        }),
      ).rejects.toThrow("disposable rollback probe");
      expect(
        await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='playing_areas' AND column_name='daily_reserve_slots'`,
      ).toHaveLength(0);
      await sql.begin((tx) => tx.unsafe(migration));
      expect(
        await sql`SELECT to_jsonb(a)-'daily_reserve_slots' AS original FROM playing_areas a WHERE competition_id=${archived}`,
      ).toEqual(before);
      expect((await sql<{ hash: string }[]>`SELECT phase4_capacity_hash(${archived}) AS hash`)[0]!.hash).toBe(
        legacyHash,
      );
      expect(
        (await sql`SELECT daily_reserve_slots FROM playing_areas WHERE competition_id=${archived}`)[0]!
          .daily_reserve_slots,
      ).toBe(null);
      await expect(
        sql`UPDATE playing_areas SET daily_reserve_slots='{}'::jsonb WHERE competition_id=${archived}`,
      ).rejects.toThrow(/archived competitions are immutable/i);
      const areaId = (await sql<{ id: string }[]>`SELECT id FROM playing_areas WHERE competition_id=${active}`)[0]!.id;
      for (const value of [[], { "2027-02-30": 1 }, { "2027-10-30": -1 }, { "2027-10-30": 0.2 }]) {
        await expect(
          sql`UPDATE playing_areas SET daily_reserve_slots=${sql.json(value)} WHERE id=${areaId}`,
        ).rejects.toThrow(/check constraint/);
      }
      for (const dailyReserveSlots of [
        null,
        {},
        { "2027-10-30": 1, "2027-10-31": 2 },
        { "2027-10-30": 99, "2027-10-31": 99 },
      ]) {
        const input: CalendarCapacityInput = {
          timeZone: "Europe/London",
          slotMinutes: 30,
          areas: [{ id: areaId, name: "Legacy Court", fixedReserveSlots: 2, dailyReserveSlots }],
          availability: [
            { id: randomUUID(), areaId, date: "2027-10-30", startTime: "23:00", endTime: "03:00", crossMidnight: true },
            { id: randomUUID(), areaId, date: "2027-10-31", startTime: "09:00", endTime: "10:10" },
          ],
          unavailable: [{ id: randomUUID(), areaId, date: "2027-10-31", startTime: "01:15", endTime: "02:00" }],
        };
        await sql`DELETE FROM competition_availability_windows WHERE competition_id=${active}`;
        await sql`DELETE FROM playing_area_unavailable_intervals WHERE competition_id=${active}`;
        await sql`UPDATE playing_areas SET daily_reserve_slots=${dailyReserveSlots === null ? null : sql.json(dailyReserveSlots)} WHERE id=${areaId}`;
        const resolved = resolveCalendarCapacityWindows(input);
        for (const window of resolved.availability)
          await sql`INSERT INTO competition_availability_windows (id,competition_id,playing_area_id,starts_at,ends_at) VALUES (${window.id},${active},${areaId},${window.startIso},${window.endIso})`;
        for (const window of resolved.unavailable)
          await sql`INSERT INTO playing_area_unavailable_intervals (id,competition_id,playing_area_id,starts_at,ends_at) VALUES (${window.id},${active},${areaId},${window.startIso},${window.endIso})`;
        const domain = calculateCalendarCapacity(input);
        const result = (
          await sql<{ raw_slots: number; available_slots: number }[]>`SELECT * FROM phase3_capacity_totals(${active})`
        )[0]!;
        expect(result.raw_slots).toBe(domain.rawTotalSlots);
        expect(result.available_slots).toBe(domain.availableMatchSlots);
      }
      await expect(
        sql`INSERT INTO playing_areas (competition_id,name,slot_minutes) VALUES (${active},'Mismatched',45)`,
      ).rejects.toThrow(/one competition slot duration/);
    } finally {
      await sql.end({ timeout: 2 });
      await dropTestSchema(databaseUrl, schema);
    }
  }, 60_000);
});
