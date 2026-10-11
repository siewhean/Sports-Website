import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "matchday-backup-controls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const key of ["age-key", "ssh-key"]) writeFileSync(path.join(dir, key), "test-only");
  const fake = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  return { dir, fake, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

test("nightly unit refuses missing or malformed deployed SHA before invoking Docker", (t) => {
  const f = fixture(t);
  const invoked = path.join(f.dir, "invoked");
  f.fake("docker", `printf '%s' "$CANDIDATE_SHA" > '${invoked}'`);
  const service = readFileSync(path.join(here, "matchday-backup.service"), "utf8");
  assert.match(service, /ExecStart=\/bin\/bash .*run-deployed-backup\.sh/);
  const command = readFileSync(path.join(here, "run-deployed-backup.sh"), "utf8");
  for (const sha of ["", "latest", "a".repeat(39), "A".repeat(40), "a".repeat(40) + "\ninvalid"]) {
    const result = spawnSync("bash", ["-c", command], { env: { ...f.env, ACTIVE_SHA: sha }, encoding: "utf8" });
    assert.equal(result.status, 2);
  }
  assert.throws(() => readFileSync(invoked));
  const sha = "a".repeat(40);
  const result = spawnSync("bash", ["-c", command], { env: { ...f.env, ACTIVE_SHA: sha } });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(invoked, "utf8"), sha);
});

for (const failure of ["none", "remote", "cleanup", "stage"]) {
  test(`restore rehearsal fails closed for ${failure} and labels its limited evidence scope`, (t) => {
    const f = fixture(t);
    f.fake(
      "ssh",
      `case "$*" in
      *"umask 077"*) cat >/dev/null; [ "$FAKE_FAILURE" = stage ] && exit 1; exit 0;;
      *"cleanup_failed=0"*) [ "$FAKE_FAILURE" = cleanup ] && exit 1; exit 0;;
      *) printf 'BACKUP_STATUS=ok\nRESTORE_STATUS=ok\nCOUNTS=MATCH\n'; [ "$FAKE_FAILURE" = remote ] && exit 1; exit 0;;
    esac`,
    );
    const result = spawnSync(
      "bash",
      [
        path.join(here, "restore-drill.sh"),
        "--key",
        path.join(f.dir, "age-key"),
        "--ssh-key",
        path.join(f.dir, "ssh-key"),
        "--host",
        "test-only.invalid",
      ],
      {
        env: { ...f.env, FAKE_FAILURE: failure },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
    if (failure === "none")
      assert.match(result.stdout, /evidence_scope=same_host_row_count_rehearsal production_certification=false/);
    else assert.doesNotMatch(result.stdout, /RESTORE_DRILL=PASS/);
  });
}
