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

  it("repairs schedule validators without changing semantics or other schemas", async () => {
    const sourceUrl = new URL(parseConfig(process.env).databaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(sourceUrl.hostname)) {
      throw new Error("Restore regression requires a loopback disposable PostgreSQL server");
    }
    const database = `test_cp9a1_validators_${randomUUID().replaceAll("-", "")}`;
    const admin = postgres(sourceUrl.toString(), { max: 1, onnotice: () => undefined });
    const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-restore-validators-"));
    sourceUrl.pathname = `/${database}`;
    const databaseUrl = sourceUrl.toString();
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    type Snapshot = Record<string, postgres.JSONValue> & {
      constraints: Record<string, { mode: string; value: postgres.JSONValue; weight: number }>;
      matches: Record<string, postgres.JSONValue>[];
      slots: Record<string, postgres.JSONValue>[];
    };
    const snapshot = JSON.parse(
      await readFile(path.resolve(migrationsDirectory, "../tests/fixtures/cp9a1-schedule-input.json"), "utf8"),
    ) as Snapshot;
    const intervals = [{ start_epoch_ms: 1_800_000_000_000, end_epoch_ms: 1_800_003_600_000 }];
    const helpers = [
      "phase4_json_exact_keys",
      "phase4_json_nonnegative_integer",
      "phase3_json_positive_integer",
      "phase4_schedule_intervals_valid",
      "phase4_schedule_constraint_value_valid",
    ];
    const names = [
      "phase4_schedule_intervals_valid",
      "phase4_schedule_constraint_value_valid",
      "phase4_schedule_input_valid",
    ];
    const historical = await readFile(path.join(migrationsDirectory, "0013_phase4_organiser_alpha.sql"), "utf8");
    const originalBody = (name: string) =>
      historical.split(`CREATE FUNCTION ${name}(`)[1]?.split("AS $$")[1]?.split("$$ LANGUAGE")[0];
    const validate = async (schema: string, valid: boolean) => {
      const [interval] =
        await sql`SELECT ${sql(schema)}.phase4_schedule_intervals_valid(${sql.json(intervals)}) AS valid`;
      expect(interval?.valid).toBe(valid);
      expect(Object.keys(snapshot.constraints)).toHaveLength(11);
      for (const [key, setting] of Object.entries(snapshot.constraints)) {
        const [constraint] =
          await sql`SELECT ${sql(schema)}.phase4_schedule_constraint_value_valid(${key},${sql.json(setting.value)}) AS valid`;
        expect(constraint?.valid, key).toBe(valid);
      }
      const [input] = await sql`SELECT ${sql(schema)}.phase4_schedule_input_valid(${sql.json(snapshot)}) AS valid`;
      expect(input?.valid).toBe(valid);
    };
    const invalid = async (schema: string) => {
      for (const value of [[{ start_epoch_ms: 2, end_epoch_ms: 1 }], [{ start_epoch_ms: 1 }], {}]) {
        const [row] = await sql`SELECT ${sql(schema)}.phase4_schedule_intervals_valid(${sql.json(value)}) AS valid`;
        expect(row?.valid).toBe(false);
      }
      for (const key of [...Object.keys(snapshot.constraints), "unsupported"]) {
        const [row] =
          await sql`SELECT ${sql(schema)}.phase4_schedule_constraint_value_valid(${key},'{}'::jsonb) AS valid`;
        expect(row?.valid, key).toBe(false);
      }
      const missingOfficials = structuredClone(snapshot);
      delete missingOfficials.matches[0]!.official_ids;
      for (const value of [{}, { ...snapshot, schema_version: 2 }, { ...snapshot, slots: [] }, missingOfficials]) {
        const [row] = await sql`SELECT ${sql(schema)}.phase4_schedule_input_valid(${sql.json(value)}) AS valid`;
        expect(row?.valid).toBe(false);
      }
    };
    const definitions = (schema: string) => sql`SELECT oid,proname,prosrc,provolatile,proisstrict,
      pg_get_functiondef(oid) AS definition,xmin::text AS version FROM pg_proc
      WHERE pronamespace=${schema}::regnamespace AND proname=ANY(${names}) ORDER BY proname`;
    const publicState = async () => ({
      functions: await sql`SELECT oid,pg_get_functiondef(oid) AS definition,xmin::text AS version
        FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`,
      migrations: await sql`SELECT name,checksum,xmin::text AS version FROM public.schema_migrations ORDER BY name`,
    });
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      await cp(migrationsDirectory, directory, { recursive: true });
      await rm(path.join(directory, validatorRepair));
      const beforeMigration = await migrateDatabase({ databaseUrl, migrationsDirectory: directory });
      expect(beforeMigration.current).toHaveLength(65);
      expect(beforeMigration.current.at(-1)).toBe(repair);
      expect(Object.keys(snapshot)).toHaveLength(11);
      expect(snapshot.matches).toHaveLength(36);
      expect(snapshot.slots).toHaveLength(72);
      expect(snapshot.matches.every((match) => Array.isArray(match.official_ids))).toBe(true);
      const beforeDefinitions = await definitions("public");
      await validate("public", true);
      await invalid("public");
      await sql`CREATE TABLE public.cp9a1_existing_schedule_input (
        input_snapshot jsonb NOT NULL CHECK (public.phase4_schedule_input_valid(input_snapshot)),
        input_hash text NOT NULL CHECK (input_hash=public.phase4_sha256_json(input_snapshot))
      )`;
      await sql`INSERT INTO public.cp9a1_existing_schedule_input(input_snapshot,input_hash)
        VALUES (${sql.json(snapshot)},public.phase4_sha256_json(${sql.json(snapshot)}))`;
      const existingBefore = await sql`SELECT input_snapshot,input_hash,xmin::text AS version
        FROM public.cp9a1_existing_schedule_input`;
      await sql`SET search_path = ''`;
      await validate("public", false);
      await sql`SET search_path = public`;
      expect((await migrateDatabase({ databaseUrl, migrationsDirectory })).applied).toEqual([validatorRepair]);
      expect((await migrateDatabase({ databaseUrl, migrationsDirectory })).applied).toEqual([]);
      const afterDefinitions = await definitions("public");
      expect(afterDefinitions).toHaveLength(3);
      for (const definition of afterDefinitions) {
        const before = beforeDefinitions.find((item) => item.proname === definition.proname);
        expect(definition.oid).toBe(before?.oid);
        expect(definition.provolatile).toBe(before?.provolatile);
        expect(definition.proisstrict).toBe(before?.proisstrict);
        let normalized = definition.prosrc as string;
        for (const helper of helpers) normalized = normalized.replaceAll(`public.${helper}(`, `${helper}(`);
        expect(normalized).toBe(originalBody(definition.proname as string));
      }
      await sql`SET search_path = ''`;
      await validate("public", true);
      await invalid("public");
      expect(
        await sql`SELECT input_snapshot,input_hash,xmin::text AS version
        FROM public.cp9a1_existing_schedule_input`,
      ).toEqual(existingBefore);
      const [existingValidation] = await sql`SELECT
        public.phase4_schedule_input_valid(input_snapshot) AS valid,
        input_hash=public.phase4_sha256_json(input_snapshot) AS hash_unchanged
        FROM public.cp9a1_existing_schedule_input`;
      expect(existingValidation).toEqual({ valid: true, hash_unchanged: true });
      const publicBefore = await publicState();
      const schema = `test_cp9a1_validators_${randomUUID().replaceAll("-", "")}`;
      const custom = await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
      expect(custom.current).toHaveLength(66);
      expect(await publicState()).toEqual(publicBefore);
      const customDefinitions = await definitions(schema);
      expect(customDefinitions).toHaveLength(3);
      for (const definition of customDefinitions) {
        let normalized = definition.prosrc as string;
        expect(normalized).not.toContain("public.");
        for (const helper of helpers) normalized = normalized.replaceAll(`${schema}.${helper}(`, `${helper}(`);
        expect(normalized).toBe(originalBody(definition.proname as string));
        expect(definition.provolatile).toBe("i");
        expect(definition.proisstrict).toBe(false);
      }
      await sql`SET search_path = ''`;
      await validate(schema, true);
      await invalid(schema);
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
});
