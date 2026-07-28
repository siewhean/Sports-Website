import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoGateCC3Secrets,
  gateCC3PhysicalPlatforms,
  gateCC3PhysicalScenarios,
  gateCC3Projects,
  gateCC3RequiredScreenshotPaths,
  gateCC3Scenarios,
  gateCC3ScenarioAssertions,
  gateCC3ScenarioObservationKeys,
  requiredGateCC3Commands,
  validateGateCC3Certification,
  validateGateCC3DiscoveryOutput,
  validateGateCC3PhysicalReceipts,
  validateGateCC3ProjectReceipt,
  validateGateCC3RunReceipt,
  verifyGateCC3ArtifactHashes,
  verifyGateCC3ScenarioArtifacts,
  writeAndVerifyTreeSeal,
} from "./run-gate-c-c3-ledger.mjs";
import { createHash } from "node:crypto";

const sourceSha = "a".repeat(40);
const hashes = Array.from({ length: 64 }, (_, index) => (index % 16).toString(16)).join("");

function projectReceipt(projectName, isolation) {
  const scenarios = gateCC3Scenarios.map((scenario) => ({
    scenario,
    status: "passed",
    receipt_sha256: uniqueHash(`${projectName}-${scenario}`),
  }));
  return {
    artifact_kind: "gate-c-c3-project-evidence",
    source_sha: sourceSha,
    project_name: projectName,
    pass_count: 1,
    failed_count: 0,
    skipped_count: 0,
    postgresql: { identifier_sha256: isolation("postgres") },
    redis: {
      namespace_sha256: isolation("redis"),
      initial_owned_key_count: 0,
      final_owned_key_count: 0,
      unrelated_guard_preserved: true,
    },
    browser_profile_sha256: isolation("profile"),
    browser_version: "1",
    indexeddb_schema_version: 1,
    service_worker_version: "matchday-scoring-shell-v4",
    screenshot_paths: [...gateCC3RequiredScreenshotPaths],
    scenarios,
    artifact_hashes: [
      ...scenarios.map((scenario) => ({
        path: `scenarios/${scenario.scenario}.json`,
        sha256: scenario.receipt_sha256,
        size_bytes: 42,
      })),
      ...gateCC3RequiredScreenshotPaths.map((screenshot) => ({
        path: screenshot,
        sha256: uniqueHash(screenshot),
        size_bytes: 42,
      })),
    ],
  };
}

function uniqueHash(value) {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

function physicalReceipt(platform) {
  const scenarios = gateCC3PhysicalScenarios.map((scenario) => ({
    scenario,
    status: "passed",
    receipt_sha256: uniqueHash(`${platform}-${scenario}`),
  }));
  const receipt = {
    artifact_kind: "gate-c-c3-physical-device-receipt",
    source_sha: sourceSha,
    platform,
    status: "passed",
    failed_count: 0,
    skipped_count: 0,
    device_model: platform === "ios" ? "Physical iPhone" : "Budget Android",
    os_version: "1",
    browser_name: platform === "ios" ? "Safari" : "Chrome",
    browser_version: "1",
    collected_at: "2026-07-28T00:00:00.000Z",
    trusted_https_origin_sha256: hashes,
    profile_identifier_sha256: uniqueHash(`${platform}-profile`),
    tester_attestation_sha256: uniqueHash(`${platform}-attestation`),
    scenarios,
    artifact_hashes: scenarios.map((scenario) => ({
      path: `scenarios/${scenario.scenario}.json`,
      sha256: scenario.receipt_sha256,
      size_bytes: 42,
    })),
  };
  return {
    ...receipt,
    receipt_sha256: createHash("sha256").update(canonicalEvidenceJson(receipt)).digest("hex"),
  };
}

function canonicalEvidenceJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function certification() {
  const projects = (runNumber) =>
    gateCC3Projects.map((project, index) =>
      projectReceipt(project, (kind) => uniqueHash(`${runNumber}-${index}-${kind}`)),
    );
  return {
    schema_version: 1,
    artifact_kind: "gate-c-c3-exact-sha-ledger",
    source_sha: sourceSha,
    environment: {
      node_version: "v24.18.0",
      pnpm_version: "10.33.0",
      postgresql_version: "18.4",
      redis_version: "8.2.7",
      mailpit_version: "1.27.9",
      playwright_version: "1.61.1",
      browser_versions: { chromium: "1", webkit: "1", firefox: "1" },
    },
    commands: [
      ...requiredGateCC3Commands.map(({ label, command, args }) => ({
        label,
        command: [command, ...args].join(" "),
        exit_code: 0,
        failed_count: 0,
        skipped_count: 0,
        log_sha256: hashes,
      })),
      ...[1, 2].map((run) => ({
        label: `gate-c-c3-real-${run}`,
        command: "pnpm test:e2e:gate-c-c3:real",
        exit_code: 0,
        failed_count: 0,
        skipped_count: 0,
        log_sha256: hashes,
      })),
    ],
    discovery_counts: Object.fromEntries(gateCC3Projects.map((project) => [project, 1])),
    runs: [
      { run_number: 1, projects: projects(1) },
      { run_number: 2, projects: projects(2) },
    ],
    physical_devices: gateCC3PhysicalPlatforms.map(physicalReceipt),
  };
}

test("Gate C C3 discovery requires all five projects and an exact total", () => {
  const output = [
    "Listing tests:",
    ...gateCC3Projects.map((project) => `  [${project}] › gate-c-c3-real.spec.ts:1:1 › journey`),
    "Total: 5 tests in 1 file",
  ].join("\n");
  assert.equal(validateGateCC3DiscoveryOutput(output), 5);
  assert.throws(
    () => validateGateCC3DiscoveryOutput(output.replace(`[${gateCC3Projects[4]}]`, "[wrong]")),
    /discovered no tests/,
  );
  assert.throws(() => validateGateCC3DiscoveryOutput(output.replace("Total: 5", "Total: 4")), /inconsistent/);
});

test("Gate C C3 browser harness cannot re-enable automatic credential-bearing captures", async () => {
  const config = await readFile("apps/web/playwright.gate-c-c3.config.ts", "utf8");
  const journey = await readFile("apps/web/tests/gate-c-c3-real.spec.ts", "utf8");
  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.match(config, /video:\s*"off"/u);
  assert.doesNotMatch(config, /retain-on-failure|only-on-failure/u);
  assert.doesNotMatch(journey, /page\.goto\([^)]*#access=/u);
});

test("Gate C C3 run receipt rejects wrong SHA, skips, and incomplete project matrices", () => {
  const receipt = {
    artifact_kind: "gate-c-c3-run-evidence",
    source_sha: sourceSha,
    pass_count: 5,
    failed_count: 0,
    skipped_count: 0,
    projects: gateCC3Projects.map((project_name) => ({
      project_name,
      pass_count: 1,
      duration_ms: 1,
      evidence_path: `${project_name}/project-evidence.json`,
    })),
  };
  assert.equal(validateGateCC3RunReceipt(receipt, sourceSha).length, 5);
  assert.throws(() => validateGateCC3RunReceipt({ ...receipt, source_sha: "b".repeat(40) }, sourceSha), /exact-SHA/);
  assert.throws(() => validateGateCC3RunReceipt({ ...receipt, skipped_count: 1 }, sourceSha), /all-pass/);
  assert.throws(
    () => validateGateCC3RunReceipt({ ...receipt, projects: receipt.projects.slice(1) }, sourceSha),
    /all-pass/,
  );
});

test("Gate C C3 project receipt requires every scenario and retained hash", () => {
  const receipt = projectReceipt(gateCC3Projects[0], (kind) => uniqueHash(kind));
  assert.equal(validateGateCC3ProjectReceipt(receipt, sourceSha, gateCC3Projects[0], 1), receipt);
  assert.throws(
    () =>
      validateGateCC3ProjectReceipt(
        { ...receipt, scenarios: receipt.scenarios.slice(1) },
        sourceSha,
        gateCC3Projects[0],
        1,
      ),
    /every required offline scenario/,
  );
  assert.throws(
    () =>
      validateGateCC3ProjectReceipt(
        { ...receipt, artifact_hashes: [{ ...receipt.artifact_hashes[0], sha256: "bad" }] },
        sourceSha,
        gateCC3Projects[0],
        1,
      ),
    /lowercase SHA-256/,
  );
});

test("Gate C C3 physical evidence is mandatory for distinct iOS and Android devices", () => {
  const receipts = gateCC3PhysicalPlatforms.map(physicalReceipt);
  assert.equal(validateGateCC3PhysicalReceipts(receipts, sourceSha).length, 2);
  assert.throws(() => validateGateCC3PhysicalReceipts(receipts.slice(1), sourceSha), /requires one physical iOS/);
  assert.throws(
    () => validateGateCC3PhysicalReceipts([physicalReceipt("ios"), physicalReceipt("ios")], sourceSha),
    /duplicated or missing/,
  );
  assert.throws(
    () =>
      validateGateCC3PhysicalReceipts(
        [{ ...physicalReceipt("android"), skipped_count: 1 }, physicalReceipt("ios")],
        sourceSha,
      ),
    /incomplete or failed/,
  );
});

test("Gate C C3 exact-SHA certification rejects reused isolation and missing commands", () => {
  const manifest = certification();
  assert.equal(validateGateCC3Certification(manifest, sourceSha), manifest);
  const reused = structuredClone(manifest);
  reused.runs[1].projects[0].postgresql.identifier_sha256 = reused.runs[0].projects[0].postgresql.identifier_sha256;
  assert.throws(() => validateGateCC3Certification(reused, sourceSha), /reused PostgreSQL/);
  const missing = structuredClone(manifest);
  missing.commands.pop();
  assert.throws(() => validateGateCC3Certification(missing, sourceSha), /canonical required command/);
  const crossedCount = structuredClone(manifest);
  crossedCount.discovery_counts[gateCC3Projects[0]] = 2;
  assert.throws(() => validateGateCC3Certification(crossedCount, sourceSha), /all-pass exact-SHA project receipt/);
  assert.throws(() => validateGateCC3Certification(manifest, "b".repeat(40)), /expected source SHA/);
});

test("Gate C C3 evidence rejects secret-like fields and values recursively", () => {
  assert.doesNotThrow(() => assertNoGateCC3Secrets({ identifier_sha256: hashes }));
  assert.throws(() => assertNoGateCC3Secrets({ nested: { access_token: "redacted" } }), /Secret-like evidence field/);
  assert.throws(() => assertNoGateCC3Secrets({ nested: [{ note: "Bearer abc.def" }] }), /Secret-like evidence value/);
  assert.throws(() => assertNoGateCC3Secrets({ notes: ["Bearer leaked.secret"] }), /Secret-like evidence value/);
  assert.throws(
    () => assertNoGateCC3Secrets({ connection: "postgres://user:password@localhost/db" }),
    /Secret-like evidence value/,
  );
  assert.throws(
    () => assertNoGateCC3Secrets({ note: "set-cookie: scoring_session=raw-value" }),
    /Secret-like evidence value/,
  );
  assert.throws(
    () => assertNoGateCC3Secrets({ note: "Authorization: Basic Zm9vOmJhcg==" }),
    /Secret-like evidence value/,
  );
  assert.throws(
    () => assertNoGateCC3Secrets({ note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzY29yZXIifQ.signature123" }),
    /Secret-like evidence value/,
  );
  assert.throws(() => assertNoGateCC3Secrets({ note: "-----BEGIN PRIVATE KEY-----" }), /Secret-like evidence value/);
});

test("Gate C C3 artifact validation reopens retained bytes and rejects hash drift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-artifacts-"));
  await writeFile(path.join(directory, "receipt.json"), "retained");
  const artifact = {
    path: "receipt.json",
    sha256: "ca67bd59cc4116ac80db5f64cbf4747f26ba929c85e8cc689a6123368d08719b",
    size_bytes: 8,
  };
  await verifyGateCC3ArtifactHashes(directory, [artifact]);
  await writeFile(path.join(directory, "receipt.json"), "changed");
  await assert.rejects(() => verifyGateCC3ArtifactHashes(directory, [artifact]), /differs from retained bytes/);
  await assert.rejects(
    () => verifyGateCC3ArtifactHashes(directory, [{ ...artifact, path: "../escape" }]),
    /escaped its retained directory/,
  );
});

test("Gate C C3 final tree seal reopens and hash-binds the complete ledger", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-tree-seal-"));
  await mkdir(path.join(directory, "logs"));
  await writeFile(path.join(directory, "ledger.json"), '{"status":"passed"}\n');
  await writeFile(path.join(directory, "logs", "check.log"), "passed\n");
  await writeAndVerifyTreeSeal(directory, sourceSha);
  const seal = JSON.parse(await readFile(path.join(directory, "ledger-seal.json"), "utf8"));
  assert.equal(seal.source_sha, sourceSha);
  assert.deepEqual(
    seal.entries.map((entry) => entry.path),
    ["ledger.json", "logs/check.log"],
  );
  assert.match(seal.tree_sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(() => writeFile(path.join(directory, "ledger.json"), "changed\n"));
});

test("Gate C C3 scenario evidence parses canonical exact-owner assertions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate-c-c3-scenarios-"));
  await mkdir(path.join(directory, "scenarios"));
  const receipt = projectReceipt(gateCC3Projects[0], (kind) => uniqueHash(kind));
  receipt.artifact_hashes = [];
  for (const scenario of receipt.scenarios) {
    const document = {
      artifact_kind: "gate-c-c3-scenario-receipt",
      source_sha: sourceSha,
      owner_kind: "project",
      owner_name: gateCC3Projects[0],
      scenario: scenario.scenario,
      status: "passed",
      observed_at: "2026-07-28T00:00:00.000Z",
      assertions: gateCC3ScenarioAssertions[scenario.scenario],
      observations: Object.fromEntries(gateCC3ScenarioObservationKeys[scenario.scenario].map((key) => [key, true])),
    };
    const bytes = `${JSON.stringify(document)}\n`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    scenario.receipt_sha256 = sha256;
    receipt.artifact_hashes.push({
      path: `scenarios/${scenario.scenario}.json`,
      sha256,
      size_bytes: Buffer.byteLength(bytes),
    });
    await writeFile(path.join(directory, `scenarios/${scenario.scenario}.json`), bytes);
  }
  await mkdir(path.join(directory, "screenshots"));
  for (const screenshot of gateCC3RequiredScreenshotPaths) {
    const bytes = Buffer.from([137, 80, 78, 71]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    receipt.artifact_hashes.push({ path: screenshot, sha256, size_bytes: bytes.byteLength });
    await writeFile(path.join(directory, screenshot), bytes);
  }
  validateGateCC3ProjectReceipt(receipt, sourceSha, gateCC3Projects[0], 1);
  await verifyGateCC3ArtifactHashes(directory, receipt.artifact_hashes);
  await verifyGateCC3ScenarioArtifacts(directory, receipt, "project", gateCC3Projects[0]);
  const first = receipt.artifact_hashes[0];
  const parsed = JSON.parse(await readFile(path.join(directory, first.path), "utf8"));
  parsed.owner_name = "crossed-project";
  await writeFile(path.join(directory, first.path), `${JSON.stringify(parsed)}\n`);
  await assert.rejects(
    () => verifyGateCC3ScenarioArtifacts(directory, receipt, "project", gateCC3Projects[0]),
    /not canonical/,
  );
});
