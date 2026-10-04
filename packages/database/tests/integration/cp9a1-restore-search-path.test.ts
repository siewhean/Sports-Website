import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const repair = "0065_cp9a1_restore_search_path_safety.sql";
const validatorRepair = "0066_cp9a1_restore_validator_search_path_safety.sql";
const nested = { z: { b: 2, a: 1 }, a: [{ b: true, A: null }, [3, "x"]] };
const reordered = { a: [{ A: null, b: true }, [3, "x"]], z: { a: 1, b: 2 } };
const expected = '{"a":[{"A":null,"b":true},[3,"x"]],"z":{"a":1,"b":2}}';
const expectedHash = "1e76a8aac02b4e110f0432c25e6d3c6541485ad48a9d8058d27df75564dc2cf5";
const validScheduleConstraintValues = {
  "minimum_rest": {
    "minutes": 15
  },
  "maximum_matches_per_day": {
    "matches": 3
  },
  "preferred_final_time": {
    "target_start_epoch_ms": 1000,
    "tolerance_minutes": 30
  },
  "entry_unavailable": {
    "by_entry_id": {}
  },
  "official_availability": {
    "by_official_id": {}
  },
  "featured_playing_area": {
    "area_id": "00000000-0000-4000-8000-000000000108",
    "match_ids": [
      "00000000-0000-4000-8000-000000000103"
    ]
  },
  "avoid_consecutive_matches": {
    "minutes": 5
  },
  "balance_early_matches": {
    "before_local_time": "09:00"
  },
  "balance_late_matches": {
    "at_or_after_local_time": "18:00"
  },
  "keep_division_together": {
    "maximum_area_count": 1
  },
  "preserve_existing_schedule": {
    "maximum_shift_minutes": 0,
    "by_match_id": {}
  }
} as const;
const validScheduleInput = {
  "schema_version": 1,
  "job_id": "00000000-0000-4000-8000-000000000101",
  "competition_id": "00000000-0000-4000-8000-000000000102",
  "source_revision": 1,
  "time_zone": "UTC",
  "objective": "balanced",
  "capacity_revision": 1,
  "capacity_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "matches": [
    {
      "match_id": "00000000-0000-4000-8000-000000000103",
      "division_id": "00000000-0000-4000-8000-000000000104",
      "duration_minutes": 30,
      "dependency_match_ids": [],
      "possible_entry_ids": [
        "00000000-0000-4000-8000-000000000105",
        "00000000-0000-4000-8000-000000000106"
      ],
      "official_ids": [],
      "is_championship_final": false
    }
  ],
  "slots": [
    {
      "slot_id": "slot-1",
      "interval_id": "00000000-0000-4000-8000-000000000107",
      "area_id": "00000000-0000-4000-8000-000000000108",
      "start_epoch_ms": 1000,
      "end_epoch_ms": 2000
    }
  ],
  "constraints": {
    "minimum_rest": {
      "mode": "preferred",
      "value": {
        "minutes": 15
      },
      "weight": 1
    },
    "maximum_matches_per_day": {
      "mode": "required",
      "value": {
        "matches": 3
      }
    },
    "preferred_final_time": {
      "mode": "preferred",
      "value": {
        "target_start_epoch_ms": 1000,
        "tolerance_minutes": 30
      },
      "weight": 1
    },
    "entry_unavailable": {
      "mode": "ignored",
      "value": {
        "by_entry_id": {}
      }
    },
    "official_availability": {
      "mode": "ignored",
      "value": {
        "by_official_id": {}
      }
    },
    "featured_playing_area": {
      "mode": "ignored",
      "value": {
        "area_id": "00000000-0000-4000-8000-000000000108",
        "match_ids": [
          "00000000-0000-4000-8000-000000000103"
        ]
      }
    },
    "avoid_consecutive_matches": {
      "mode": "preferred",
      "value": {
        "minutes": 5
      },
      "weight": 1
    },
    "balance_early_matches": {
      "mode": "preferred",
      "value": {
        "before_local_time": "09:00"
      },
      "weight": 1
    },
    "balance_late_matches": {
      "mode": "preferred",
      "value": {
        "at_or_after_local_time": "18:00"
      },
      "weight": 1
    },
    "keep_division_together": {
      "mode": "preferred",
      "value": {
        "maximum_area_count": 1
      },
      "weight": 1
    },
    "preserve_existing_schedule": {
      "mode": "ignored",
      "value": {
        "maximum_shift_minutes": 0,
        "by_match_id": {}
      }
    }
  }
} as const;

describeInfrastructure("CP9A.1 restore search-path safety", () => {
  it("preserves canonical outputs and hashes while repairing empty-search-path recursion", async () => {
    const sourceUrl = new URL(parseConfig(process.env).databaseUrl);
    // This regression creates and drops only a uniquely named local disposable database.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(sourceUrl.hostname)) {
      throw new Error("Restore regression requires a loopback disposable PostgreSQL server");
    }
    const database = `test_cp9a1_restore_${randomUUID().replaceAll("-", "")}`;
    const admin = postgres(sourceUrl.toString(), { max: 1, onnotice: () => undefined });
    const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-restore-search-path-"));
    sourceUrl.pathname = `/${database}`;
    const databaseUrl = sourceUrl.toString();
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      await cp(migrationsDirectory, directory, { recursive: true });
      await rm(path.join(directory, repair));
      await rm(path.join(directory, validatorRepair));
      await migrateDatabase({ databaseUrl, migrationsDirectory: directory });
      const historical = await readFile(
        path.join(migrationsDirectory, "0050_phase3_sport_pack_hash_scope_fence.sql"),
        "utf8",
      );
      const [before] = await sql`SELECT public.phase3_canonical_jsonb(${sql.json(nested)}) AS generic,
        public.phase3_canonical_sport_pack_jsonb(${sql.json(nested)}) AS sport,
        public.phase4_sha256_json(${sql.json(nested)}) AS hash`;
      expect(before).toEqual({ generic: expected, sport: expected, hash: expectedHash });
      await sql`SET search_path = ''`;
      for (const helper of [
        "phase3_canonical_jsonb",
        "phase3_canonical_sport_pack_jsonb",
        "phase4_json_object_without_forbidden_keys",
      ]) {
        await expect(sql`SELECT public.${sql(helper)}(${sql.json(nested)})`).rejects.toMatchObject({
          code: "42883",
        });
      }
      await sql`SET search_path = public`;
      await cp(path.join(migrationsDirectory, repair), path.join(directory, repair));
      expect((await migrateDatabase({ databaseUrl, migrationsDirectory: directory })).applied).toEqual([repair]);
      const definitions = await sql`SELECT proname,prosrc,provolatile FROM pg_proc
        WHERE oid IN ('public.phase3_canonical_jsonb(jsonb)'::regprocedure,
          'public.phase3_canonical_sport_pack_jsonb(jsonb)'::regprocedure)`;
      for (const definition of definitions) {
        const previousBody = historical
          .split(`FUNCTION ${definition.proname}(value jsonb) RETURNS text AS $$`)[1]
          ?.split("$$ LANGUAGE")[0];
        expect(definition.prosrc.replaceAll(`public.${definition.proname}(`, `${definition.proname}(`)).toBe(
          previousBody,
        );
        expect(definition.provolatile).toBe("i");
      }
      const guardHistorical = await readFile(path.join(migrationsDirectory, "0013_phase4_organiser_alpha.sql"), "utf8");
      const [guard] = await sql`SELECT prosrc,provolatile,proisstrict FROM pg_proc
        WHERE oid='public.phase4_json_object_without_forbidden_keys(jsonb)'::regprocedure`;
      expect(
        guard?.prosrc.replaceAll(
          "public.phase4_json_object_without_forbidden_keys(",
          "phase4_json_object_without_forbidden_keys(",
        ),
      ).toBe(
        guardHistorical
          .split("FUNCTION phase4_json_object_without_forbidden_keys(value jsonb) RETURNS boolean AS $$")[1]
          ?.split("$$ LANGUAGE")[0],
      );
      expect(guard).toMatchObject({ provolatile: "i", proisstrict: true });
      await sql`SET search_path = ''`;
      const [guardResults] = await sql`SELECT
        public.phase4_json_object_without_forbidden_keys(${sql.json(nested)}) AS allowed,
        public.phase4_json_object_without_forbidden_keys(${sql.json({ nested: [{ deeper: { token: "synthetic" } }] })}) AS forbidden,
        public.phase4_json_object_without_forbidden_keys(NULL) AS null_result`;
      expect(guardResults).toEqual({ allowed: true, forbidden: false, null_result: null });
      for (const input of [nested, reordered]) {
        const [after] = await sql`SELECT public.phase3_canonical_jsonb(${sql.json(input)}) AS generic,
          public.phase3_canonical_sport_pack_jsonb(${sql.json(input)}) AS sport,
          public.phase4_sha256_json(${sql.json(input)}) AS hash,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            public.phase3_canonical_sport_pack_jsonb(${sql.json(input)}), 'UTF8')), 'hex') AS sport_hash`;
        expect(after).toEqual({ generic: expected, sport: expected, hash: expectedHash, sport_hash: expectedHash });
      }
      // Custom migration schemas must repair their own helpers without replacing public functions.
      const publicBefore = await sql`SELECT oid,proname,pg_get_functiondef(oid) AS definition,xmin::text AS version
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
          ('phase3_canonical_jsonb','phase3_canonical_sport_pack_jsonb','phase4_json_object_without_forbidden_keys')
        ORDER BY proname`;
      const schema = `test_cp9a1_custom_${randomUUID().replaceAll("-", "")}`;
      await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
      const publicAfter = await sql`SELECT oid,proname,pg_get_functiondef(oid) AS definition,xmin::text AS version
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
          ('phase3_canonical_jsonb','phase3_canonical_sport_pack_jsonb','phase4_json_object_without_forbidden_keys')
        ORDER BY proname`;
      expect(publicAfter).toEqual(publicBefore);
      const customDefinitions = await sql`SELECT proname,prosrc,provolatile,proisstrict FROM pg_proc
        WHERE pronamespace=${schema}::regnamespace AND proname IN
          ('phase3_canonical_jsonb','phase3_canonical_sport_pack_jsonb','phase4_json_object_without_forbidden_keys')`;
      expect(customDefinitions).toHaveLength(3);
      for (const definition of customDefinitions) {
        const isGuard = definition.proname === "phase4_json_object_without_forbidden_keys";
        const source = isGuard ? guardHistorical : historical;
        const type = isGuard ? "boolean" : "text";
        const previousBody = source
          .split(`FUNCTION ${definition.proname}(value jsonb) RETURNS ${type} AS $$`)[1]
          ?.split("$$ LANGUAGE")[0];
        expect(definition.prosrc.replaceAll(`${schema}.${definition.proname}(`, `${definition.proname}(`)).toBe(
          previousBody,
        );
        expect(definition.provolatile).toBe("i");
        expect(definition.proisstrict).toBe(isGuard);
      }
      await sql`SET search_path = ''`;
      for (const input of [nested, reordered]) {
        const [customResult] = await sql`SELECT
          ${sql(schema)}.phase3_canonical_jsonb(${sql.json(input)}) AS generic,
          ${sql(schema)}.phase3_canonical_sport_pack_jsonb(${sql.json(input)}) AS sport,
          ${sql(schema)}.phase4_sha256_json(${sql.json(input)}) AS hash,
          ${sql(schema)}.phase4_json_object_without_forbidden_keys(${sql.json(input)}) AS allowed,
          ${sql(schema)}.phase4_json_object_without_forbidden_keys(${sql.json({ nested: [{ secret: "synthetic" }] })}) AS forbidden`;
        expect(customResult).toEqual({
          generic: expected,
          sport: expected,
          hash: expectedHash,
          allowed: true,
          forbidden: false,
        });
      }
    } finally {
      await sql.end({ timeout: 2 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } finally {
        await admin.end({ timeout: 2 });
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
  it("repairs schedule validators under an empty search_path without changing semantics", async () => {
    const sourceUrl = new URL(parseConfig(process.env).databaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(sourceUrl.hostname)) {
      throw new Error("Restore validator regression requires a loopback disposable PostgreSQL server");
    }
    const database = "test_cp9a1_validator_" + randomUUID().replaceAll("-", "");
    const admin = postgres(sourceUrl.toString(), { max: 1, onnotice: () => undefined });
    const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-restore-validator-path-"));
    sourceUrl.pathname = "/" + database;
    const databaseUrl = sourceUrl.toString();
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE "' + database + '"');
      await cp(migrationsDirectory, directory, { recursive: true });
      await rm(path.join(directory, validatorRepair));
      await migrateDatabase({ databaseUrl, migrationsDirectory: directory });

      const [normalInput] = await sql`SELECT public.phase4_schedule_input_valid(${sql.json(validScheduleInput)}) AS valid`;
      expect(normalInput?.valid).toBe(true);

      await sql`SET search_path = ''`;
      const validIntervals = [{ start_epoch_ms: 1000, end_epoch_ms: 2000 }];
      const [beforeIntervals] = await sql`SELECT public.phase4_schedule_intervals_valid(${sql.json(validIntervals)}) AS valid`;
      expect(beforeIntervals?.valid).toBe(false);
      for (const [constraintKey, value] of Object.entries(validScheduleConstraintValues)) {
        const [beforeConstraint] = await sql`SELECT
          public.phase4_schedule_constraint_value_valid(${constraintKey}, ${sql.json(value)}) AS valid`;
        expect(beforeConstraint?.valid, constraintKey).toBe(false);
      }
      const [beforeInput] = await sql`SELECT public.phase4_schedule_input_valid(${sql.json(validScheduleInput)}) AS valid`;
      expect(beforeInput?.valid).toBe(false);

      await sql`SET search_path = public`;
      await cp(path.join(migrationsDirectory, validatorRepair), path.join(directory, validatorRepair));
      expect((await migrateDatabase({ databaseUrl, migrationsDirectory: directory })).applied).toEqual([validatorRepair]);

      await sql`SET search_path = ''`;
      const [afterIntervals] = await sql`SELECT public.phase4_schedule_intervals_valid(${sql.json(validIntervals)}) AS valid`;
      expect(afterIntervals?.valid).toBe(true);
      for (const [constraintKey, value] of Object.entries(validScheduleConstraintValues)) {
        const [afterConstraint] = await sql`SELECT
          public.phase4_schedule_constraint_value_valid(${constraintKey}, ${sql.json(value)}) AS valid`;
        expect(afterConstraint?.valid, constraintKey).toBe(true);
      }
      const [afterInput] = await sql`SELECT public.phase4_schedule_input_valid(${sql.json(validScheduleInput)}) AS valid`;
      expect(afterInput?.valid).toBe(true);
      const [badIntervals] = await sql`SELECT public.phase4_schedule_intervals_valid(
        ${sql.json([{ start_epoch_ms: 2000, end_epoch_ms: 1000 }])}
      ) AS valid`;
      expect(badIntervals?.valid).toBe(false);
      const invalidInput = { ...validScheduleInput, slots: [] };
      const [badInput] = await sql`SELECT public.phase4_schedule_input_valid(${sql.json(invalidInput)}) AS valid`;
      expect(badInput?.valid).toBe(false);

      const historical = await readFile(path.join(migrationsDirectory, "0013_phase4_organiser_alpha.sql"), "utf8");
      const helperNames = [
        "phase4_json_exact_keys",
        "phase4_json_nonnegative_integer",
        "phase3_json_positive_integer",
        "phase4_schedule_intervals_valid",
        "phase4_schedule_constraint_value_valid",
      ];
      const signatures: Record<string, string> = {
        phase4_schedule_intervals_valid:
          "FUNCTION phase4_schedule_intervals_valid(value jsonb) RETURNS boolean AS $$",
        phase4_schedule_constraint_value_valid:
          "FUNCTION phase4_schedule_constraint_value_valid(constraint_key text,value jsonb) RETURNS boolean AS $$",
        phase4_schedule_input_valid:
          "FUNCTION phase4_schedule_input_valid(value jsonb) RETURNS boolean AS $$",
      };
      const definitions = await sql`SELECT proname,prosrc,provolatile,proisstrict FROM pg_proc
        WHERE oid IN (
          'public.phase4_schedule_intervals_valid(jsonb)'::regprocedure,
          'public.phase4_schedule_constraint_value_valid(text,jsonb)'::regprocedure,
          'public.phase4_schedule_input_valid(jsonb)'::regprocedure
        ) ORDER BY proname`;
      expect(definitions).toHaveLength(3);
      for (const definition of definitions) {
        const previousBody = historical.split(signatures[definition.proname]!)[1]?.split("$$ LANGUAGE")[0];
        let normalized = definition.prosrc;
        for (const helper of helperNames) normalized = normalized.replaceAll("public." + helper + "(", helper + "(");
        expect(normalized).toBe(previousBody);
        expect(definition.provolatile).toBe("i");
        expect(definition.proisstrict).toBe(false);
      }

      await sql`SET search_path = public`;
      const publicBefore = await sql`SELECT oid,proname,pg_get_functiondef(oid) AS definition,xmin::text AS version
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
          ('phase4_schedule_intervals_valid','phase4_schedule_constraint_value_valid','phase4_schedule_input_valid')
        ORDER BY proname`;
      const schema = "test_cp9a1_validator_custom_" + randomUUID().replaceAll("-", "");
      await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
      const publicAfter = await sql`SELECT oid,proname,pg_get_functiondef(oid) AS definition,xmin::text AS version
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
          ('phase4_schedule_intervals_valid','phase4_schedule_constraint_value_valid','phase4_schedule_input_valid')
        ORDER BY proname`;
      expect(publicAfter).toEqual(publicBefore);
      const customDefinitions = await sql`SELECT proname,prosrc,provolatile,proisstrict FROM pg_proc
        WHERE pronamespace=${schema}::regnamespace AND proname IN
          ('phase4_schedule_intervals_valid','phase4_schedule_constraint_value_valid','phase4_schedule_input_valid')
        ORDER BY proname`;
      expect(customDefinitions).toHaveLength(3);
      for (const definition of customDefinitions) {
        const previousBody = historical.split(signatures[definition.proname]!)[1]?.split("$$ LANGUAGE")[0];
        let normalized = definition.prosrc;
        for (const helper of helperNames) normalized = normalized.replaceAll(schema + "." + helper + "(", helper + "(");
        expect(normalized).toBe(previousBody);
        expect(definition.provolatile).toBe("i");
        expect(definition.proisstrict).toBe(false);
      }

      await sql`SET search_path = ''`;
      const [customInput] = await sql`SELECT
        ${sql(schema)}.phase4_schedule_input_valid(${sql.json(validScheduleInput)}) AS valid`;
      expect(customInput?.valid).toBe(true);
      const [customIntervals] = await sql`SELECT
        ${sql(schema)}.phase4_schedule_intervals_valid(${sql.json(validIntervals)}) AS valid`;
      expect(customIntervals?.valid).toBe(true);
      for (const [constraintKey, value] of Object.entries(validScheduleConstraintValues)) {
        const [customConstraint] = await sql`SELECT
          ${sql(schema)}.phase4_schedule_constraint_value_valid(
            ${constraintKey},
            ${sql.json(value)}
          ) AS valid`;
        expect(customConstraint?.valid, constraintKey).toBe(true);
      }
    } finally {
      await sql.end({ timeout: 2 });
      try {
        await admin.unsafe('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
      } finally {
        await admin.end({ timeout: 2 });
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 45_000);

});
