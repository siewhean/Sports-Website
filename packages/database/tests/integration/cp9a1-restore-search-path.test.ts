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
});
