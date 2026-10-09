import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.join(here, "matchday-backup.sh");
const restoreScript = path.join(here, "restore-postgres.sh");
const RECIPIENT = `age1${"q".repeat(58)}`;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// In-memory S3 double. Real curl --aws-sigv4 talks to it, so request signing and the
// x-amz-content-sha256 payload hash are exercised end to end.
async function startS3(options = {}) {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const authorization = req.headers.authorization ?? "";
      requests.push({ method: req.method, path: url.pathname, authorization });
      if (!authorization.startsWith("AWS4-HMAC-SHA256")) {
        res.writeHead(403).end("missing signature");
        return;
      }
      const [, bucket, ...rest] = url.pathname.split("/");
      assert.equal(bucket, "test-bucket", "path-style addressing expected");
      const key = rest.join("/");
      if (req.method === "PUT") {
        if (req.headers["x-amz-content-sha256"] !== sha256(body)) {
          res.writeHead(400).end("XAmzContentSHA256Mismatch");
          return;
        }
        objects.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(
            ([k, v]) =>
              `<Contents><Key>${k}</Key><LastModified>2026-01-01T00:00:00Z</LastModified><Size>${v.length}</Size></Contents>`,
          )
          .join("\n");
        res
          .writeHead(200, { "content-type": "application/xml" })
          .end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
      } else if (req.method === "GET") {
        const value = objects.get(key);
        if (!value) res.writeHead(404).end("NoSuchKey");
        else if (options.corruptDownloads && !key.endsWith(".sha256"))
          res.writeHead(200).end(Buffer.from(value).fill(0x58));
        else res.writeHead(200).end(value);
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    objects,
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "matchday-backup-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const backupDir = path.join(directory, "backups");
  mkdirSync(bin);
  mkdirSync(backupDir);
  const log = path.join(directory, "tools.log");
  const tool = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  // pg_dump --file OUT ...
  tool(
    "pg_dump",
    `[ -n "$FAKE_PG_DUMP_FAILS" ] && { echo "pg_dump: connection refused" >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = "--file" ] && out=$2; shift; done
printf 'PGDMP-fake-archive-%s' "$FAKE_DUMP_SALT" > "$out"`,
  );
  tool("pg_restore", `[ -n "$FAKE_PG_RESTORE_FAILS" ] && exit 1\nexit 0`);
  tool(
    "age",
    `decrypt=0; out=; in=
while [ $# -gt 0 ]; do case "$1" in --decrypt) decrypt=1;; --recipient|--identity) shift;; --output) out=$2; shift;; *) in=$1;; esac; shift; done
if [ $decrypt = 1 ]; then tail -c +5 "$in" > "$out"; else { printf 'AGE:'; cat "$in"; } > "$out"; fi`,
  );
  tool(
    "psql",
    `case "$*" in
  *--command*) [ -n "$FAKE_DB_EXISTS" ] && echo 1 ;;
  *) cat >/dev/null; echo "public.example|3" ;;
esac
exit 0`,
  );
  tool("createdb", "exit 0");
  tool("dropdb", "exit 0");

  const baseEnv = (s3, extra = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PGHOST: "postgres",
    PGUSER: "matchday_prod",
    PGPASSWORD: "test-password",
    PGDATABASE: "matchday_prod",
    BACKUP_DIR: backupDir,
    BACKUP_S3_ENDPOINT: s3.endpoint,
    BACKUP_S3_REGION: "ap-singapore-1",
    BACKUP_S3_BUCKET: "test-bucket",
    BACKUP_S3_ACCESS_KEY_ID: "AKIATESTKEY",
    BACKUP_S3_SECRET_ACCESS_KEY: "test-secret",
    BACKUP_S3_TIMEOUT: "20",
    BACKUP_AGE_RECIPIENT: RECIPIENT,
    FAKE_DUMP_SALT: "one",
    ...extra,
  });

  const run = (script, args, env) =>
    new Promise((resolve) => {
      const child = spawn("bash", [script, ...args], { env, cwd: directory });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  return { directory, backupDir, log, baseEnv, run, toolLog: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

const keysUnder = (s3, prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();

test("nightly backup: dump -> age -> verified upload -> status/heartbeat files", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: "0" }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /BACKUP_STATUS=ok/);

  const daily = keysUnder(s3, "postgres/daily/");
  assert.equal(daily.length, 2);
  const payload = daily.find((k) => k.endsWith(".dump.age"));
  assert.match(payload, /^postgres\/daily\/matchday-matchday_prod-\d{8}T\d{6}Z\.dump\.age$/);
  const body = s3.objects.get(payload);
  assert.ok(body.subarray(0, 4).toString() === "AGE:", "object must be age-encrypted, never plaintext");
  assert.ok(!daily.some((k) => k.endsWith(".dump")), "plaintext dump must not be uploaded");
  assert.ok(
    !existsSync(path.join(f.backupDir, "daily", path.basename(payload).replace(/\.age$/, ""))),
    "plaintext removed locally",
  );
  const sidecar = s3.objects.get(`${payload}.sha256`).toString();
  assert.ok(sidecar.startsWith(sha256(body)));
  assert.equal(keysUnder(s3, "postgres/weekly/").length, 0);

  const status = JSON.parse(readFileSync(path.join(f.backupDir, "status/status.json"), "utf8"));
  assert.equal(status.status, "ok");
  assert.equal(status.bytes, body.length);
  assert.ok(existsSync(path.join(f.backupDir, "status/last-success")));
  assert.ok(f.toolLog().includes("pg_dump --format=custom"));
  // Credentials were sent signed, not in argv.
  assert.ok(s3.requests.every((q) => q.authorization.includes("Credential=AKIATESTKEY/")));
  assert.ok(!r.stdout.includes("test-secret") && !r.stderr.includes("test-secret"));
});

test("weekly copy is written on the weekly day", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const dow = String(new Date().getUTCDay() || 7);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: dow }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(keysUnder(s3, "postgres/weekly/").length, 2);
});

test("retention keeps 14 dailies and 8 weeklies and removes matching sidecars", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const seed = (kind, count) => {
    for (let i = 1; i <= count; i += 1) {
      const key = `postgres/${kind}/matchday-matchday_prod-2025${String(i).padStart(2, "0")}01T000000Z.dump.age`;
      s3.objects.set(key, Buffer.from("old"));
      s3.objects.set(`${key}.sha256`, Buffer.from("x  old\n"));
    }
  };
  seed("daily", 16);
  seed("weekly", 10);
  const dow = String(new Date().getUTCDay() || 7);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: dow }));
  assert.equal(r.status, 0, r.stderr);
  const payloads = (prefix) => keysUnder(s3, prefix).filter((k) => k.endsWith(".dump.age"));
  assert.equal(payloads("postgres/daily/").length, 14);
  assert.equal(payloads("postgres/weekly/").length, 8);
  assert.equal(keysUnder(s3, "postgres/daily/").length, 28, "every kept payload keeps exactly one sidecar");
  assert.ok(
    payloads("postgres/daily/").some((k) => /2026|2027|20[3-9]\d/.test(k)),
    "the new backup is retained",
  );
  assert.ok(!s3.objects.has("postgres/daily/matchday-matchday_prod-20250101T000000Z.dump.age"));
});

test("pg_dump failure exits non-zero, logs a failure marker, uploads nothing, records failed status", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3, { FAKE_PG_DUMP_FAILS: "1" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR: pg_dump failed/);
  assert.match(r.stderr, /BACKUP_STATUS=failed/);
  assert.equal(s3.objects.size, 0);
  assert.equal(JSON.parse(readFileSync(path.join(f.backupDir, "status/status.json"), "utf8")).status, "failed");
  assert.ok(!existsSync(path.join(f.backupDir, "status/last-success")));
});

test("missing age recipient fails closed unless plaintext is explicitly allowed", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const refused = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_AGE_RECIPIENT: "" }));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to upload an unencrypted dump/);
  assert.equal(s3.objects.size, 0);

  const malformed = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_AGE_RECIPIENT: "not-a-key" }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /age public keys/);

  const allowed = await f.run(
    backupScript,
    ["backup"],
    f.baseEnv(s3, { BACKUP_AGE_RECIPIENT: "", BACKUP_ALLOW_PLAINTEXT: "1" }),
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /UNENCRYPTED/);
  assert.ok(keysUnder(s3, "postgres/daily/").some((k) => k.endsWith(".dump")));
});

test("upload verification catches corrupted object storage content", async (t) => {
  const s3 = await startS3({ corruptDownloads: true });
  t.after(() => s3.close());
  const f = createFixture(t);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum verification failed/);
  assert.match(r.stderr, /BACKUP_STATUS=failed/);
});

test("unreachable or misconfigured Object Storage fails loudly", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const missing = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_S3_BUCKET: "" }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BACKUP_S3_BUCKET/);
  const insecure = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_S3_ENDPOINT: "http://example.com" }));
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /must be an https/);
});

test("bucket usage above BACKUP_MAX_TOTAL_BYTES fails the run", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const r = await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_MAX_TOTAL_BYTES: "10" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exceeds BACKUP_MAX_TOTAL_BYTES/);
});

test("upload-snapshot encrypts and stores a pre-migration dump under premigration/", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  const dump = path.join(f.directory, "premigration-20260101T000000Z-abcdef123456.dump");
  writeFileSync(dump, "PGDMP-snapshot");
  const r = await f.run(backupScript, ["upload-snapshot", dump], f.baseEnv(s3));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(keysUnder(s3, "postgres/premigration/"), [
    "postgres/premigration/premigration-20260101T000000Z-abcdef123456.dump.age",
    "postgres/premigration/premigration-20260101T000000Z-abcdef123456.dump.age.sha256",
  ]);
  const missing = await f.run(backupScript, ["upload-snapshot", "/nonexistent"], f.baseEnv(s3));
  assert.notEqual(missing.status, 0);
});

test("restore: download, verify checksum, decrypt and pg_restore into a scratch database", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  assert.equal((await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: "0" }))).status, 0);
  const identity = path.join(f.directory, "identity.txt");
  writeFileSync(identity, "AGE-SECRET-KEY-FAKE\n");

  const listed = await f.run(restoreScript, ["--list"], f.baseEnv(s3));
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /postgres\/daily\/matchday-matchday_prod-.*\.dump\.age/);

  const r = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "matchday_restore_drill", "--identity", identity],
    f.baseEnv(s3),
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /RESTORE_STATUS=ok target=matchday_restore_drill/);
  assert.match(r.stdout, /checksum verified/);
  const log = f.toolLog();
  assert.match(log, /createdb matchday_restore_drill/);
  assert.match(
    log,
    /pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname matchday_restore_drill/,
  );
  assert.ok(
    !/--clean/.test(
      log
        .split("\n")
        .filter((l) => l.startsWith("pg_restore --no-owner"))
        .join("\n"),
    ),
  );

  // Encrypted artifact without an identity is rejected.
  const noKey = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "matchday_restore_drill2"],
    f.baseEnv(s3),
  );
  assert.notEqual(noKey.status, 0);
  assert.match(noKey.stderr, /--identity/);
});

test("restore refuses to overwrite the production database without the explicit flag", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  assert.equal((await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: "0" }))).status, 0);
  const identity = path.join(f.directory, "identity.txt");
  writeFileSync(identity, "AGE-SECRET-KEY-FAKE\n");

  const refused = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "matchday_prod", "--identity", identity],
    f.baseEnv(s3),
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /production database; refusing/);
  assert.ok(!f.toolLog().includes("pg_restore --clean"));

  const system = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "postgres", "--identity", identity],
    f.baseEnv(s3),
  );
  assert.notEqual(system.status, 0);

  const allowed = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "matchday_prod", "--identity", identity, "--allow-production-overwrite"],
    f.baseEnv(s3),
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(f.toolLog(), /pg_restore --clean --if-exists/);
});

test("restore refuses a download whose checksum does not match, and an existing target without --replace-target", async (t) => {
  const s3 = await startS3();
  t.after(() => s3.close());
  const f = createFixture(t);
  assert.equal((await f.run(backupScript, ["backup"], f.baseEnv(s3, { BACKUP_WEEKLY_DAY: "0" }))).status, 0);
  const identity = path.join(f.directory, "identity.txt");
  writeFileSync(identity, "AGE-SECRET-KEY-FAKE\n");

  const exists = await f.run(
    restoreScript,
    ["--latest", "daily", "--target-db", "matchday_restore_drill", "--identity", identity],
    f.baseEnv(s3, { FAKE_DB_EXISTS: "1" }),
  );
  assert.notEqual(exists.status, 0);
  assert.match(exists.stderr, /already exists; pass --replace-target/);

  const payloadKey = keysUnder(s3, "postgres/daily/").find((k) => k.endsWith(".dump.age"));
  s3.objects.set(payloadKey, Buffer.from("AGE:tampered"));
  const tampered = await f.run(
    restoreScript,
    ["--key", payloadKey, "--target-db", "matchday_restore_drill", "--identity", identity],
    f.baseEnv(s3),
  );
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /checksum mismatch/);
});
