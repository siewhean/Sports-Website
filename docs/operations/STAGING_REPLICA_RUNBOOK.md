# Staging Replica Runbook

**Status:** Procedure documented; no staging host has been marked or seeded yet.
**Track:** R8.2 (staging copy with realistic data)
**Scripts:** [`staging-mark-database.ts`](../../apps/api/scripts/staging-mark-database.ts), [`seed-staging-production-replica.ts`](../../apps/api/scripts/seed-staging-production-replica.ts), guards in [`staging-db-guards.ts`](../../apps/api/scripts/staging-db-guards.ts)

---

## 1. Safety model

The replica seeder writes thousands of rows. It must never reach production. It runs three checks before writing, and all three must pass:

| Layer           | Check                                                                                                                                                           | What it catches                                                             |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| URL guard       | `APP_ENV`/`NODE_ENV` is not `production`; URL host is not `129.146.6.204` or a protected pattern; database name has no `prod`; host is in the staging whitelist | Typos and production URLs pasted by mistake                                 |
| Server identity | Connected server's `pg_control_system().system_identifier` is in `STAGING_DB_SYSTEM_IDENTIFIERS`; `inet_server_addr()` is not the production IP                 | SSH tunnels, port-forwards and DNS mistakes that make production look local |
| Staging marker  | `staging_environment_markers.primary_marker` exists, is staging, and is bound to the same `system_identifier`                                                   | Unmarked databases, and staging dumps restored onto another cluster         |

**Why tunnels are covered by the identity check.** With `ssh -L 5433:prod-db:5432`, the URL is `postgres://...@127.0.0.1:5433/...`, so the URL guard sees loopback and passes. The server on the far end still reports its own `system_identifier`, which is not in the staging allowlist, so the seeder refuses. Client-side `SSH_CLIENT`/`SSH_CONNECTION` variables and local network interfaces describe the machine running the script, not the database, so they cannot detect this. The seeder no longer checks them.

The seeder never creates the marker. There is no flag or env var for it.

---

## 2. One-time: mark the staging database (operator, on the staging host)

Run this on the staging host, interactively, as an operator with DDL rights on the staging database.

1. Confirm you are on the staging host (`hostname`, cloud console) and that `DATABASE_URL` points at the staging cluster.
2. Read the cluster identifier directly on the host:

   ```bash
   psql "$DATABASE_URL" -Atc "SELECT system_identifier FROM pg_control_system();"
   ```

3. Compare it against the production identifier recorded by the production owner. **If they match, stop.**
4. Add the staging identifier to the allowlist in the staging host's environment (never in production's):

   ```bash
   export STAGING_DB_SYSTEM_IDENTIFIERS=<staging system_identifier>
   ```

5. Run the marker step and type the identifier when prompted:

   ```bash
   pnpm staging:mark-database
   ```

   It refuses if: `APP_ENV`/`NODE_ENV` is production, the URL fails the URL guard, the server reports the production address, the identifier is not allowlisted, stdin is not a TTY, or what you typed does not match.

---

## 3. Seed the replica

```bash
STAGING_DB_SYSTEM_IDENTIFIERS=<staging system_identifier> \
DATABASE_URL=postgres://...@staging-db.internal:5432/matchday_staging \
pnpm seed:staging:replica --allow-staging-seed
```

The seeder prints the server identity it verified. Any guard failure aborts before the first write.

---

## 4. When the guards refuse

| Message                                        | Meaning and action                                                                                                   |
| :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| `STAGING_DB_SYSTEM_IDENTIFIERS is empty`       | Allowlist not set. Set it on the staging host (section 2).                                                           |
| `... is not in STAGING_DB_SYSTEM_IDENTIFIERS`  | You are connected to a different cluster, possibly through a tunnel. Stop and check where `DATABASE_URL` leads.      |
| `lacks a verified 'this is staging' marker`    | Database not marked. Run section 2 on the staging host.                                                              |
| `Staging marker is bound to system_identifier` | Marker came from another cluster (restored dump). Confirm this cluster is staging, then mark it again (section 2).   |
| `Unable to read database server identity`      | The role cannot call `pg_control_system()`. Grant `pg_monitor` (or run as the owner role) on staging. Do not bypass. |
