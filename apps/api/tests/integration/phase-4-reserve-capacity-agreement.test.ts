import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { Phase3Runtime, type Phase3CapacityReplaceInput } from "../../src/phase-3-runtime.js";
import { capacityMatchSlots, type CapacityWindowRow } from "../../src/phase-4-capacity-slots.js";

// Redesign Phase 0: one reserve rule everywhere. For random persisted capacities, the domain count
// the organiser sees, SQL `phase3_available_match_slots` (which gates format publication and
// recommendation evidence) and the slots the solver is offered all agree.
const runInfrastructure = process.env.RUN_INFRA_TESTS === "1";
const describeInfrastructure = runInfrastructure ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const schema = `test_reserve_agreement_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let client!: Sql;
let phase3!: Phase3Runtime;
let ownerId = "";
let organisationId = "";

const actor = () => ({ accountId: ownerId });
const pad = (value: number) => String(value).padStart(2, "0");
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

function seeded(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

beforeAll(async () => {
  if (!runInfrastructure) return;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_INFRA_TESTS=1");
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  client = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: schema } });
  ownerId = (
    await client<{ id: string }[]>`
      INSERT INTO accounts(primary_email,display_name,email_verified_at)
      VALUES('owner@reserve.test','Owner',now()) RETURNING id`
  )[0]!.id;
  await client.begin(async (tx) => {
    organisationId = (
      await tx<{ id: string }[]>`INSERT INTO organisations(name,slug) VALUES('Reserve Org','reserve-org') RETURNING id`
    )[0]!.id;
    await tx`INSERT INTO organisation_memberships(organisation_id,account_id,role,status)
      VALUES(${organisationId},${ownerId},'owner','active')`;
  });
  phase3 = new Phase3Runtime(client as unknown as PostgresJsSql, phase3DomainAdapter);
}, 120_000);

afterAll(async () => {
  if (!runInfrastructure) return;
  await client?.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describeInfrastructure("reserve slots: domain, SQL and solver agree (redesign Phase 0)", () => {
  it.each([
    { timezone: "Asia/Singapore", startsOn: "2027-10-29", seed: 101, slotMinutes: 30 },
    // Straddles the Europe/London autumn DST change on 2027-10-31.
    { timezone: "Europe/London", startsOn: "2027-10-29", seed: 202, slotMinutes: 45 },
    { timezone: "America/New_York", startsOn: "2027-11-06", seed: 303, slotMinutes: 20 },
  ])(
    "agrees across 70 random persisted capacities in $timezone",
    async ({ timezone, startsOn, seed, slotMinutes }) => {
      const random = seeded(seed);
      const start = new Date(`${startsOn}T00:00:00Z`);
      const dates = [0, 1, 2].map((offset) =>
        new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10),
      );
      const competition = await phase3.createCompetition(
        actor(),
        {
          organisationId,
          name: `Reserve ${timezone}`,
          slug: `reserve-${randomUUID()}`,
          sportCode: "badminton",
          venue: "Hall",
          address: "1 Hall Road",
          countryCode: "SG",
          startsOn: dates[0]!,
          endsOn: dates[2]!,
          timezone,
          locale: "en-SG",
        },
        randomUUID(),
      );
      let revision = 1;
      let areaIds: string[] = [];
      let checkedReserves = 0;
      for (let sample = 0; sample < 70; sample += 1) {
        const areaCount = 1 + random(3);
        const areas: Phase3CapacityReplaceInput["areas"] = Array.from({ length: areaCount }, (_, index) => {
          const days = dates.slice(0, 1 + random(3));
          return {
            ...(areaIds[index] ? { id: areaIds[index] } : {}),
            name: `Court ${index + 1}`,
            slotMinutes,
            fixedReserveSlots: random(9),
            availability: days.flatMap((date) => {
              const open = 7 * 60 + random(4) * 30;
              const windows = [{ date, startTime: clock(open), endTime: clock(open + 90 + random(5) * 60) }];
              if (random(2) === 0) {
                const afternoon = 14 * 60 + random(3) * 20;
                windows.push({ date, startTime: clock(afternoon), endTime: clock(afternoon + 60 + random(4) * 35) });
              }
              return windows;
            }),
            unavailable:
              random(3) === 0
                ? [
                    {
                      date: days[0]!,
                      startTime: clock(8 * 60 + 5 * random(6)),
                      endTime: clock(8 * 60 + 40 + 5 * random(4)),
                    },
                  ]
                : [],
          };
        });
        const saved = await phase3.replaceCapacity(actor(), competition.id, { revision, areas }, randomUUID());
        revision = saved.revision;
        areaIds = saved.areas.map((area) => area.id);

        const [sql] = await client<{ available: number }[]>`
        SELECT phase3_available_match_slots(${competition.id}::uuid) AS available`;
        const areaRows = await client<{ id: string; slot_minutes: number; fixed_reserve_slots: number }[]>`
        SELECT id,slot_minutes,fixed_reserve_slots FROM playing_areas WHERE competition_id=${competition.id}
        ORDER BY sort_order,id`;
        // Only areas in this save have windows; areas retained from earlier saves contribute nothing.
        const windowRows = await client<CapacityWindowRow[]>`
        SELECT id,playing_area_id,starts_at,ends_at,source_date::text date,
          to_char(source_start_time,'HH24:MI') start_time,to_char(source_end_time,'HH24:MI') end_time,
          source_cross_midnight cross_midnight
        FROM competition_availability_windows WHERE competition_id=${competition.id}`;
        const unavailableRows = await client<CapacityWindowRow[]>`
        SELECT id,playing_area_id,starts_at,ends_at,source_date::text date,
          to_char(source_start_time,'HH24:MI') start_time,to_char(source_end_time,'HH24:MI') end_time,
          source_cross_midnight cross_midnight
        FROM playing_area_unavailable_intervals WHERE competition_id=${competition.id}`;
        const offered = capacityMatchSlots(
          windowRows,
          unavailableRows,
          slotMinutes,
          areaRows.map((area) => ({ ...area, slot_minutes: slotMinutes })),
          timezone,
        );
        const context = { timezone, sample, effective: saved.effective, sql: sql!.available, offered: offered.length };
        expect(saved.effective.availableMatchSlots, JSON.stringify(context)).toBe(sql!.available);
        expect(offered.length, JSON.stringify(context)).toBe(sql!.available);
        checkedReserves += saved.effective.rawTotalSlots - saved.effective.availableMatchSlots;
      }
      expect(checkedReserves).toBeGreaterThan(50);
    },
    120_000,
  );
});
