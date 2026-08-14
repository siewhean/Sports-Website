import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVIDENCE_ONLY_PATHS,
  REQUIRED_COMMANDS,
  validatePhase4FinalEvidence,
} from "./validate-phase-4-final-evidence.mjs";

const COMMIT = "a".repeat(40);
const HASH = "b".repeat(64);

function completeManifest() {
  return {
    schema_version: 1,
    local_validation: "PASS",
    hosted_github_actions: "Not executed because Actions allowance is unavailable",
    source: {
      commit_sha: COMMIT,
      branch: "codex/gate-b-lockfile-integrity",
    },
    evidence_collected_at: "2026-07-23T12:00:00.000Z",
    reviewer: { identity: "independent-local-reviewer" },
    environment: {
      operating_system: "macOS 26.6",
      architecture: "arm64",
      node_version: "v24.18.0",
      pnpm_version: "10.33.0",
      postgresql_version: "18.4",
      redis_version: "8.2.7",
      playwright_version: "1.61.1",
      chromium_version: "149.0.7827.55",
      webkit_version: "26.5",
    },
    commands: REQUIRED_COMMANDS.map(([id, exactCommand]) => ({
      id,
      exact_command: exactCommand,
      status: "PASS",
      exit_status: 0,
      duration_ms: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      skip_reason: null,
      raw_log_retention_location: `artifacts/qa/gate-b-final/${id}.log`,
      raw_log_sha256: HASH,
    })),
    isolated_journeys: [
      {
        id: "isolation-1",
        command_id: "real-journey-1",
        status: "PASS",
        database_isolation_identifier: "redacted:database-run-1",
        redis_isolation_identifier: "redacted:redis-run-1",
        browser_projects: ["phone-chromium", "tablet-webkit", "desktop-chromium"],
      },
      {
        id: "isolation-2",
        command_id: "real-journey-2",
        status: "PASS",
        database_isolation_identifier: "redacted:database-run-2",
        redis_isolation_identifier: "redacted:redis-run-2",
        browser_projects: ["phone-chromium", "tablet-webkit", "desktop-chromium"],
      },
    ],
    artifacts: {
      playwright_html_reports: [
        {
          retention_location: "artifacts/qa/gate-b-final/report.zip",
          sha256: HASH,
        },
      ],
      screenshots: [
        {
          retention_location: "artifacts/qa/gate-b-final/screenshots.zip",
          sha256: HASH,
        },
      ],
      traces: [
        {
          retention_location: "artifacts/qa/gate-b-final/traces.zip",
          sha256: HASH,
        },
      ],
    },
    summaries: {
      accessibility: { status: "PASS", wcag_a_aa_violations: 0 },
      visual: { status: "PASS", unmatched_diffs: 0 },
      browser_runtime: {
        status: "PASS",
        console_errors: 0,
        page_errors: 0,
        failed_requests: 0,
      },
    },
    residual_risks: [],
  };
}

function errorsFor(mutate) {
  const manifest = completeManifest();
  mutate(manifest);
  return validatePhase4FinalEvidence(manifest, {
    sourceCommitExists: true,
    sourceCommitIsAncestor: true,
    changedPathsSinceSource: [],
    workingTreeChangedPaths: [],
  });
}

test("accepts a complete manifest for an exact ancestor with evidence-only deltas", () => {
  assert.deepEqual(
    validatePhase4FinalEvidence(completeManifest(), {
      sourceCommitExists: true,
      sourceCommitIsAncestor: true,
      changedPathsSinceSource: [...EVIDENCE_ONLY_PATHS],
      workingTreeChangedPaths: [],
    }),
    [],
  );
});

test("rejects an unknown source commit", () => {
  const manifest = completeManifest();
  manifest.source.commit_sha = "c".repeat(40);
  const errors = validatePhase4FinalEvidence(manifest, {
    sourceCommitExists: false,
    sourceCommitIsAncestor: false,
    changedPathsSinceSource: [],
    workingTreeChangedPaths: [],
  });
  assert.ok(errors.includes("source.commit_sha does not identify a commit in this repository"));
});

test("rejects a source commit that is not an ancestor", () => {
  const manifest = completeManifest();
  const errors = validatePhase4FinalEvidence(manifest, {
    sourceCommitExists: true,
    sourceCommitIsAncestor: false,
    changedPathsSinceSource: [],
    workingTreeChangedPaths: [],
  });
  assert.ok(errors.includes("source.commit_sha is not an ancestor of the checked-out commit"));
});

test("rejects committed production or test deltas after the source commit", () => {
  const errors = validatePhase4FinalEvidence(completeManifest(), {
    sourceCommitExists: true,
    sourceCommitIsAncestor: true,
    changedPathsSinceSource: ["apps/web/app/page.tsx", "pnpm-lock.yaml"],
    workingTreeChangedPaths: [],
  });
  assert.ok(
    errors.includes("path changed after the validated source commit and is not evidence-only: apps/web/app/page.tsx"),
  );
  assert.ok(errors.includes("path changed after the validated source commit and is not evidence-only: pnpm-lock.yaml"));
});

test("rejects uncommitted non-evidence deltas", () => {
  const errors = validatePhase4FinalEvidence(completeManifest(), {
    sourceCommitExists: true,
    sourceCommitIsAncestor: true,
    changedPathsSinceSource: [],
    workingTreeChangedPaths: ["apps/api/src/phase-4-runtime.ts"],
  });
  assert.ok(
    errors.includes(
      "working tree path differs from the checked-out commit and is not evidence-only: apps/api/src/phase-4-runtime.ts",
    ),
  );
});

test("rejects a missing required command", () => {
  assert.ok(
    errorsFor((manifest) => {
      manifest.commands = manifest.commands.filter((command) => command.id !== "typecheck");
    }).includes("required command typecheck is missing"),
  );
});

test("rejects failed and skipped required commands", () => {
  const errors = errorsFor((manifest) => {
    const lint = manifest.commands.find((command) => command.id === "lint");
    lint.status = "FAIL";
    lint.exit_status = 1;
    lint.failed = 1;
    const visual = manifest.commands.find((command) => command.id === "visual");
    visual.skipped = 1;
    visual.skip_reason = "not available";
  });
  assert.ok(errors.includes("required command lint did not pass"));
  assert.ok(errors.includes("required command visual records skipped checks"));
});

test("rejects malformed hashes", () => {
  assert.ok(
    errorsFor((manifest) => {
      manifest.commands[0].raw_log_sha256 = "not-a-sha";
    }).some((error) => error.includes("64-character SHA-256")),
  );
});

test("rejects absent browser versions", () => {
  const errors = errorsFor((manifest) => {
    manifest.environment.chromium_version = "";
    delete manifest.environment.webkit_version;
  });
  assert.ok(errors.includes("environment.chromium_version must be present"));
  assert.ok(errors.includes("environment.webkit_version must be present"));
});

test("rejects either missing isolated journey", () => {
  assert.ok(
    errorsFor((manifest) => {
      manifest.isolated_journeys = manifest.isolated_journeys.slice(0, 1);
    }).includes("isolated journey isolation-2 is missing"),
  );
});

test("rejects reused isolation identifiers", () => {
  const errors = errorsFor((manifest) => {
    manifest.isolated_journeys[1].database_isolation_identifier =
      manifest.isolated_journeys[0].database_isolation_identifier;
    manifest.isolated_journeys[1].redis_isolation_identifier = manifest.isolated_journeys[0].redis_isolation_identifier;
  });
  assert.ok(errors.includes("isolated journeys reuse the same database identifier"));
  assert.ok(errors.includes("isolated journeys reuse the same Redis identifier"));
});

test("rejects secret-like fields and values", () => {
  const errors = errorsFor((manifest) => {
    manifest.api_key = "should-not-be-recorded";
    manifest.notes = ["Bearer", "abcdefghijklmnopqrstuvwxy"].join(" ");
    manifest.session = "raw-session-material";
  });
  assert.ok(errors.includes("api_key is a secret-like field"));
  assert.ok(errors.includes("notes contains a secret-like value"));
  assert.ok(errors.includes("session is a secret-like field"));
});
