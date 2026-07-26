import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { validateBrowserGateEvidence } from "./validate-browser-gate-evidence.mjs";
import { buildBrowserGateEvidence, REQUIRED_COMMANDS } from "./write-browser-gate-evidence.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixtureRoot() {
  const fixtureDirectory = path.join(os.tmpdir(), "gate-b-evidence-fixtures");
  await mkdir(fixtureDirectory, { recursive: true });
  const root = await mkdtemp(path.join(fixtureDirectory, "fixture-"));
  await writeFile(path.join(root, ".gitignore"), "evidence/\nartifacts/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Gate B test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);

  const sha = git(root, ["rev-parse", "HEAD"]);
  await mkdir(path.join(root, "evidence"));
  for (const name of ["command.log", "a11y.json", "visual.png", "review.md"]) {
    await writeFile(path.join(root, "evidence", name), `${name}\n`, "utf8");
  }
  const bundlePath = path.join("artifacts", "qa", "gate-b", sha, "evidence-bundle.tar.gz");
  await mkdir(path.dirname(path.join(root, bundlePath)), { recursive: true });
  await writeFile(path.join(root, bundlePath), "immutable bundle bytes\n", "utf8");
  return { root, sha, bundlePath };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function input(sha, bundlePath) {
  return {
    environment: {
      pnpm_version: "10.33.0",
      postgresql_version: "18.4",
      redis_version: "8.2.7",
      playwright_version: "1.61.1",
      chromium_version: "149.0.0",
      webkit_version: "26.5",
    },
    commands: REQUIRED_COMMANDS.map(([id, command]) => ({
      id,
      command,
      exit_code: 0,
      duration_ms: 1,
      counts: { passed: 3, failed: 0, skipped: 0 },
      skip_reasons: [],
      unexpected_skipped: 0,
      log_path: "evidence/command.log",
    })),
    isolation_runs: [
      {
        run_number: 1,
        command_id: "real-journeys",
        status: "PASS",
        database_identifier: "redacted:database-1",
        redis_namespace_identifier: "redacted:redis-namespace-1",
        redis_namespace_sha256: sha256("redis-namespace-1"),
        initial_owned_key_count: 0,
        final_owned_key_count: 0,
        unrelated_guard_preserved: true,
        browser_projects: ["phone-chromium", "tablet-webkit", "desktop-chromium"],
      },
      {
        run_number: 2,
        command_id: "real-journeys",
        status: "PASS",
        database_identifier: "redacted:database-2",
        redis_namespace_identifier: "redacted:redis-namespace-2",
        redis_namespace_sha256: sha256("redis-namespace-2"),
        initial_owned_key_count: 0,
        final_owned_key_count: 0,
        unrelated_guard_preserved: true,
        browser_projects: ["phone-chromium", "tablet-webkit", "desktop-chromium"],
      },
    ],
    accessibility: {
      status: "PASS",
      wcag_tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      enabled_rules: ["target-size"],
      target_size_executed: true,
      report_paths: ["evidence/a11y.json"],
    },
    visual: { status: "PASS", artifact_paths: ["evidence/visual.png"] },
    production_build: { status: "PASS", exit_code: 0 },
    browser_runtime: { console_errors: 0, page_errors: 0, failed_requests: 0 },
    review_document_path: "evidence/review.md",
    immutable_publication: { bundle_path: bundlePath },
    findings: { p0: 0, p1: 0 },
    final_verdict: "PASS",
    source_sha_for_fixture_only: sha,
  };
}

async function buildFixture() {
  const fixture = await fixtureRoot();
  const ledger = input(fixture.sha, fixture.bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const evidence = await buildBrowserGateEvidence({ root: fixture.root, input: ledger });
  return { ...fixture, ledger, evidence };
}

test("builds a sanitized manifest by hashing a real exact-SHA bundle and deriving its URI", async () => {
  const { root, sha, bundlePath, evidence } = await buildFixture();
  const bytes = await readFile(path.join(root, bundlePath));
  const digest = sha256(bytes);
  assert.equal(evidence.schema_version, 2);
  assert.equal(evidence.source.commit_sha, sha);
  assert.equal(evidence.immutable_publication.retention_location, bundlePath);
  assert.equal(evidence.immutable_publication.evidence_bundle_sha256, digest);
  assert.equal(evidence.immutable_publication.bytes, bytes.byteLength);
  assert.equal(evidence.immutable_publication.uri, `artifact://gate-b/${sha}/${digest}`);
  assert.equal(
    evidence.commands.every((command) => command.duration_ms === 1),
    true,
  );
  assert.equal(evidence.isolation_runs[1].final_owned_key_count, 0);
  assert.equal(evidence.isolation_runs[1].unrelated_guard_preserved, true);
  assert.deepEqual(await validateBrowserGateEvidence({ root, manifest: evidence }), []);
});

test("rejects caller-provided publication URI or digest, including fabricated valid-looking values", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  for (const field of [
    { uri: `artifact://gate-b/${sha}/${"a".repeat(64)}` },
    { evidence_bundle_sha256: "a".repeat(64) },
  ]) {
    const ledger = input(sha, bundlePath);
    Object.assign(ledger.immutable_publication, field);
    delete ledger.source_sha_for_fixture_only;
    await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /accepts bundle_path only/u);
  }
});

test("rejects a missing bundle and a bundle retained under another SHA", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const missing = input(sha, `${bundlePath}.missing`);
  delete missing.source_sha_for_fixture_only;
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: missing }), /is unavailable/u);

  const otherSha = "f".repeat(40);
  const otherPath = path.join("artifacts", "qa", "gate-b", otherSha, "bundle.tar.gz");
  await mkdir(path.dirname(path.join(root, otherPath)), { recursive: true });
  await writeFile(path.join(root, otherPath), "wrong SHA bundle\n", "utf8");
  const wrongSha = input(sha, otherPath);
  delete wrongSha.source_sha_for_fixture_only;
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: wrongSha }), /allowed directory/u);
});

test("validator rejects a bundle mutated after generation or deleted", async () => {
  const { root, bundlePath, evidence } = await buildFixture();
  await writeFile(path.join(root, bundlePath), "tampered and longer bundle\n", "utf8");
  let errors = await validateBrowserGateEvidence({ root, manifest: evidence });
  assert.ok(errors.includes("immutable publication bundle byte size does not match"));
  assert.ok(errors.includes("immutable publication bundle checksum does not match"));

  await rm(path.join(root, bundlePath));
  errors = await validateBrowserGateEvidence({ root, manifest: evidence });
  assert.ok(errors.includes("immutable publication bundle is unavailable"));
});

test("validator rejects non-canonical publication SHA or digest URI", async () => {
  const { root, evidence } = await buildFixture();
  const alteredSha = structuredClone(evidence);
  alteredSha.immutable_publication.uri = `artifact://gate-b/${"f".repeat(40)}/${
    evidence.immutable_publication.evidence_bundle_sha256
  }`;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: alteredSha })).includes(
      "immutable publication URI is not canonical for HEAD and digest",
    ),
  );

  const alteredDigest = structuredClone(evidence);
  alteredDigest.immutable_publication.uri = `artifact://gate-b/${evidence.source.commit_sha}/${"a".repeat(64)}`;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: alteredDigest })).includes(
      "immutable publication URI is not canonical for HEAD and digest",
    ),
  );

  const callerField = structuredClone(evidence);
  callerField.immutable_publication.digest = "a".repeat(64);
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: callerField })).includes(
      "immutable publication metadata is invalid",
    ),
  );
});

test("validator rejects a retained bundle path under another commit SHA", async () => {
  const { root, evidence } = await buildFixture();
  const otherSha = "f".repeat(40);
  const otherPath = path.join("artifacts", "qa", "gate-b", otherSha, "evidence-bundle.tar.gz");
  await mkdir(path.dirname(path.join(root, otherPath)), { recursive: true });
  await writeFile(path.join(root, otherPath), "immutable bundle bytes\n", "utf8");
  evidence.immutable_publication.retention_location = otherPath;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "immutable publication bundle resolves outside its allowed directory",
    ),
  );
});

test("writer and validator reject bundle symlinks, including an external target", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const outside = path.join(os.tmpdir(), `gate-b-external-${process.pid}.tar.gz`);
  await writeFile(outside, "outside\n", "utf8");
  await rm(path.join(root, bundlePath));
  await symlink(outside, path.join(root, bundlePath));

  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /must not be a symbolic link/u);

  await rm(path.join(root, bundlePath));
  await writeFile(path.join(root, bundlePath), "valid\n", "utf8");
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  await rm(path.join(root, bundlePath));
  await symlink(outside, path.join(root, bundlePath));
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "immutable publication bundle must not be a symbolic link",
    ),
  );
  await rm(outside);
});

test("writer and validator reject a symlinked exact-SHA directory even when its target stays in the repository", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });

  const exactShaDirectory = path.join(root, "artifacts", "qa", "gate-b", sha);
  const retainedDirectory = path.join(root, "artifacts", "qa", "gate-b", "retained-bundle");
  await rename(exactShaDirectory, retainedDirectory);
  await symlink("retained-bundle", exactShaDirectory, "dir");

  await assert.rejects(
    () => buildBrowserGateEvidence({ root, input: ledger }),
    /allowed directory must not contain symbolic links/u,
  );
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "immutable publication bundle allowed directory must not contain symbolic links",
    ),
  );
});

test("shared recursive policy rejects nested secret-like keys in writer input and final manifest", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  ledger.notes = [{ safe: [{ session_token: "redacted-is-still-a-forbidden-key" }] }];
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /forbidden sensitive field/u);

  delete ledger.notes;
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  evidence.notes = [{ safe: [{ session_token: "redacted-is-still-a-forbidden-key" }] }];
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).some((error) =>
      error.includes("forbidden sensitive field"),
    ),
  );

  const camelCaseLedger = input(sha, bundlePath);
  delete camelCaseLedger.source_sha_for_fixture_only;
  camelCaseLedger.notes = [{ connectionString: "redacted" }];
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: camelCaseLedger }), /forbidden sensitive field/u);
});

test("shared policy rejects bearer, JWT, credential URL, assignment, GitHub token, and private-key values", async (t) => {
  const values = [
    "Bearer abcdefghijklmnopqrst",
    "eyJabcdefghijk.abcdefghijk.abcdefghijk",
    "postgresql://username:password@example.invalid/database",
    "password=not-safe",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const [index, value] of values.entries()) {
    await t.test(`secret-like value ${index + 1}`, async () => {
      const { root, sha, bundlePath } = await fixtureRoot();
      const ledger = input(sha, bundlePath);
      delete ledger.source_sha_for_fixture_only;
      ledger.notes = [{ value }];
      await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /secret-like value/u);

      delete ledger.notes;
      const evidence = await buildBrowserGateEvidence({ root, input: ledger });
      evidence.notes = [{ value }];
      assert.ok(
        (await validateBrowserGateEvidence({ root, manifest: evidence })).some((error) =>
          error.includes("secret-like value"),
        ),
      );
    });
  }
});

test("writer and validator enforce exact canonical command text", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  ledger.commands.find((command) => command.id === "typecheck").command = "recorded typecheck";
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /canonical command/u);

  ledger.commands.find((command) => command.id === "typecheck").command = "pnpm typecheck";
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  evidence.commands.find((command) => command.id === "typecheck").command = "recorded typecheck";
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "command typecheck does not match the canonical command",
    ),
  );
});

test("writer and validator require a positive integer duration_ms for every canonical command", async (t) => {
  const cases = [
    {
      name: "missing",
      mutate(command) {
        delete command.duration_ms;
      },
    },
    {
      name: "zero",
      mutate(command) {
        command.duration_ms = 0;
      },
    },
    {
      name: "negative",
      mutate(command) {
        command.duration_ms = -1;
      },
    },
    {
      name: "non-integer",
      mutate(command) {
        command.duration_ms = 1.5;
      },
    },
  ];

  for (const durationCase of cases) {
    await t.test(durationCase.name, async () => {
      const { root, sha, bundlePath } = await fixtureRoot();
      const ledger = input(sha, bundlePath);
      delete ledger.source_sha_for_fixture_only;
      durationCase.mutate(ledger.commands.find((command) => command.id === "typecheck"));
      await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /duration_ms/u);

      ledger.commands.find((command) => command.id === "typecheck").duration_ms = 1;
      const evidence = await buildBrowserGateEvidence({ root, input: ledger });
      durationCase.mutate(evidence.commands.find((command) => command.id === "typecheck"));
      assert.ok(
        (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
          "command typecheck duration_ms must be a positive integer",
        ),
      );
    });
  }
});

test("writer and validator accept only exactly accounted intentional test-case skips", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const visual = ledger.commands.find((command) => command.id === "visual");
  visual.counts.skipped = 3;
  visual.skip_reasons = [
    { reason: "WebKit-only project applicability", count: 1 },
    { reason: "Desktop-only visual baseline", count: 2 },
  ];
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  assert.deepEqual(evidence.commands.find((command) => command.id === "visual").skip_reasons, visual.skip_reasons);
  assert.deepEqual(await validateBrowserGateEvidence({ root, manifest: evidence }), []);
});

test("writer and validator reject missing reasons for a positive skipped count", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const visual = ledger.commands.find((command) => command.id === "visual");
  visual.counts.skipped = 1;
  delete visual.skip_reasons;
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /skip_reasons must be an array/u);

  visual.skip_reasons = [];
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /explain every intentional skip/u);

  visual.skip_reasons = [{ reason: "Project applicability", count: 1 }];
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  delete evidence.commands.find((command) => command.id === "visual").skip_reasons;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "command visual skip_reasons must be an array",
    ),
  );
});

test("writer and validator reject skip-reason counts that do not match counts.skipped", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const visual = ledger.commands.find((command) => command.id === "visual");
  visual.counts.skipped = 2;
  visual.skip_reasons = [{ reason: "Project applicability", count: 1 }];
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /sum exactly/u);

  visual.skip_reasons[0].count = 2;
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  evidence.commands.find((command) => command.id === "visual").skip_reasons[0].count = 1;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "command visual skip reason counts do not equal counts.skipped",
    ),
  );
});

test("writer and validator require empty skip reasons when counts.skipped is zero", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  const visual = ledger.commands.find((command) => command.id === "visual");
  visual.skip_reasons = [{ reason: "Contradictory reason", count: 1 }];
  await assert.rejects(() => buildBrowserGateEvidence({ root, input: ledger }), /must be empty/u);

  visual.skip_reasons = [];
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  evidence.commands.find((command) => command.id === "visual").skip_reasons = [
    { reason: "Contradictory reason", count: 1 },
  ];
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "command visual skip_reasons must be empty when skipped is zero",
    ),
  );
});

test("missing Node, pnpm, lockfile, umbrella, focus repeat, or real-journeys record fails", async (t) => {
  for (const id of [
    "node-version",
    "pnpm-version",
    "lockfile-unchanged",
    "umbrella-check",
    "focus-state-repeat",
    "real-journeys",
  ]) {
    await t.test(id, async () => {
      const { root, evidence } = await buildFixture();
      evidence.commands = evidence.commands.filter((command) => command.id !== id);
      const errors = await validateBrowserGateEvidence({ root, manifest: evidence });
      assert.ok(errors.includes(`required command ${id} is missing`));
    });
  }
});

test("one canonical real-journeys command binds both clean isolation records", async () => {
  const { root, evidence } = await buildFixture();
  assert.equal(evidence.commands.filter((command) => command.id === "real-journeys").length, 1);
  assert.deepEqual(
    evidence.isolation_runs.map((run) => run.command_id),
    ["real-journeys", "real-journeys"],
  );
  assert.deepEqual(await validateBrowserGateEvidence({ root, manifest: evidence }), []);
});

test("isolation requires two distinct redacted Redis namespace identifiers and hashes", async () => {
  const { root, evidence } = await buildFixture();
  const altered = structuredClone(evidence);
  altered.isolation_runs[1].redis_namespace_identifier = altered.isolation_runs[0].redis_namespace_identifier;
  altered.isolation_runs[1].redis_namespace_sha256 = altered.isolation_runs[0].redis_namespace_sha256;
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: altered })).includes("isolation runs are not independent"),
  );
});

test("isolation uses owned-key boundaries and guard preservation, not total Redis DB size", async () => {
  const { root, sha, bundlePath } = await fixtureRoot();
  const ledger = input(sha, bundlePath);
  delete ledger.source_sha_for_fixture_only;
  ledger.isolation_runs[0].initial_dbsize = 91;
  ledger.isolation_runs[0].final_dbsize = 92;
  const evidence = await buildBrowserGateEvidence({ root, input: ledger });
  assert.equal("initial_dbsize" in evidence.isolation_runs[0], false);
  assert.deepEqual(await validateBrowserGateEvidence({ root, manifest: evidence }), []);
});

test("validator rejects a source SHA different from the checked-out SHA", async () => {
  const { root, evidence } = await buildFixture();
  evidence.source.commit_sha = "f".repeat(40);
  assert.ok(
    (await validateBrowserGateEvidence({ root, manifest: evidence })).includes(
      "artifact SHA is not the checked-out SHA",
    ),
  );
});

test("validator rejects dirty tracked source after evidence generation", async () => {
  const { root, evidence } = await buildFixture();
  await writeFile(path.join(root, "README.md"), "dirty tracked source\n", "utf8");
  assert.ok((await validateBrowserGateEvidence({ root, manifest: evidence })).includes("working tree is not clean"));
});

test("schema-1 final evidence documents are explicitly historical and superseded", async () => {
  const json = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "docs/qa/phase-4-final-evidence.json"), "utf8"));
  const markdown = await readFile(path.join(REPOSITORY_ROOT, "docs/qa/phase-4-final-evidence.md"), "utf8");
  assert.equal(json.evidence_state, "HISTORICAL_SUPERSEDED");
  assert.notEqual(json.local_validation, "PASS");
  assert.match(json.historical_notice, /HISTORICAL\/SUPERSEDED/u);
  assert.match(markdown, /HISTORICAL\/SUPERSEDED/u);
  assert.doesNotMatch(markdown, /Status:\s+\*\*FINAL\*\*/u);
  assert.doesNotMatch(markdown, /Local validation:\s+PASS/u);
});

test("package gate executes evidence tests and pnpm check includes that gate", async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["test:evidence:phase4"], "node --test scripts/write-browser-gate-evidence.test.mjs");
  assert.match(packageJson.scripts.check, /\bpnpm test:evidence:phase4\b/u);
});

test("test process itself uses the pinned Node runtime", () => {
  assert.equal(process.version, "v24.18.0");
});

test("fixture bundle is a regular non-symlink file before generation", async () => {
  const { root, bundlePath } = await fixtureRoot();
  const details = await lstat(path.join(root, bundlePath));
  assert.equal(details.isFile(), true);
  assert.equal(details.isSymbolicLink(), false);
});
