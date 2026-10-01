import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const describeInfrastructure = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const databaseUrl = parseConfig(process.env).databaseUrl;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

describeInfrastructure("casual migration upgrade", () => {
  it("adds casual tables to 0063 without changing existing rows, constraints or migration checksums", async () => {
    const schema = `test_casual_upgrade_${randomUUID().replaceAll("-", "")}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "matchday-casual-upgrade-"));
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined, connection: { search_path: schema } });
    try {
      await cp(migrationsDirectory, directory, { recursive: true });
      await rm(path.join(directory, "0064_casual_games.sql"));
      const baseline = await migrateDatabase({ databaseUrl, migrationsDirectory: directory, schema });
      expect(baseline.current).toHaveLength(63);
      const account = randomUUID();
      const recipient = randomUUID();
      await sql`INSERT INTO accounts(id,primary_email,display_name,status)
        VALUES(${account},'casual-owner@example.test','Existing owner','active'),
              (${recipient},'casual-friend@example.test','Existing friend','active')`;
      const accountsBefore = await sql`SELECT * FROM accounts ORDER BY id`;
      const ledgerBefore = await sql`SELECT name,checksum FROM schema_migrations ORDER BY name`;
      const officialConstraintsBefore = await sql`
        SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname=${schema} AND r.relname IN
          ('competition_officials','official_availability_windows','match_official_assignments')
        ORDER BY c.conname`;
      const officialIndexBefore = await sql`SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indexrelid=to_regclass(${`${schema}.competition_officials_active_name_uidx`})`;

      const upgraded = await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
      expect(upgraded.applied).toEqual(["0064_casual_games.sql"]);
      expect(upgraded.current).toHaveLength(64);
      expect(await sql`SELECT * FROM accounts ORDER BY id`).toEqual(accountsBefore);
      expect(await sql`SELECT name,checksum FROM schema_migrations WHERE name < '0064' ORDER BY name`).toEqual(
        ledgerBefore,
      );
      expect(
        await sql`
        SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname=${schema} AND r.relname IN
          ('competition_officials','official_availability_windows','match_official_assignments')
        ORDER BY c.conname`,
      ).toEqual(officialConstraintsBefore);
      expect(
        await sql`SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indexrelid=to_regclass(${`${schema}.competition_officials_active_name_uidx`})`,
      ).toEqual(officialIndexBefore);

      const game = randomUUID();
      await sql`INSERT INTO casual_games(id,owner_account_id,sport_id,home_name,away_name,host_token_hash,viewer_token_hash)
        VALUES(${game},${account},'badminton','Home','Away','host-hash','viewer-hash')`;
      await expect(sql`INSERT INTO casual_games(sport_id,home_name,away_name,host_token_hash,viewer_token_hash)
        VALUES('badminton','Home','Away','host-hash','other-viewer')`).rejects.toMatchObject({ code: "23505" });
      await expect(sql`INSERT INTO casual_games(sport_id,home_name,away_name,host_token_hash,viewer_token_hash)
        VALUES('badminton','Home','Away','other-host','viewer-hash')`).rejects.toMatchObject({ code: "23505" });
      await expect(sql`UPDATE casual_games SET target_points=100 WHERE id=${game}`).rejects.toMatchObject({
        code: "23514",
      });
      await expect(sql`UPDATE casual_games SET home_score=-1 WHERE id=${game}`).rejects.toMatchObject({
        code: "23514",
      });
      await sql`INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state)
        VALUES(${game},2,'score','{}','{}')`;
      await expect(sql`INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state)
        VALUES(${game},2,'undo','{}','{}')`).rejects.toMatchObject({ code: "23505" });
      await expect(sql`INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state)
        VALUES(${randomUUID()},1,'score','{}','{}')`).rejects.toMatchObject({ code: "23503" });
      await sql`INSERT INTO casual_game_presets(owner_account_id,name,settings) VALUES(${account},'Regular','{}')`;
      await sql`INSERT INTO casual_friend_requests(sender_id,recipient_id) VALUES(${account},${recipient})`;
      await expect(sql`INSERT INTO casual_friend_requests(sender_id,recipient_id)
        VALUES(${account},${account})`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`INSERT INTO casual_friend_requests(sender_id,recipient_id)
        VALUES(${account},${recipient})`).rejects.toMatchObject({ code: "23505" });
      await sql`INSERT INTO casual_game_shares(game_id,recipient_id) VALUES(${game},${recipient})`;
      await expect(sql`INSERT INTO casual_game_shares(game_id,recipient_id)
        VALUES(${game},${recipient})`).rejects.toMatchObject({ code: "23505" });
      await sql`DELETE FROM accounts WHERE id=${account}`;
      expect(await sql`SELECT owner_account_id FROM casual_games WHERE id=${game}`).toEqual([
        { owner_account_id: null },
      ]);
      expect(await sql`SELECT * FROM casual_game_presets`).toHaveLength(0);
      expect(await sql`SELECT * FROM casual_friend_requests`).toHaveLength(0);
      await sql`DELETE FROM casual_games WHERE id=${game}`;
      expect(await sql`SELECT * FROM casual_game_actions`).toHaveLength(0);
      expect(await sql`SELECT * FROM casual_game_shares`).toHaveLength(0);
      expect((await migrateDatabase({ databaseUrl, migrationsDirectory, schema })).applied).toEqual([]);
    } finally {
      await sql.end({ timeout: 2 });
      await dropTestSchema(databaseUrl, schema);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
