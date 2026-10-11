import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const images = source.slice(source.indexOf("\n  images:"));
const condition = images.match(/\n    if: >-\n([\s\S]*?)\n    needs:/u)[1].trim();
const permitsImages = new Function("github", "inputs", "startsWith", `return (${condition});`);

function allowed(event, ref, optIn = false) {
  return permitsImages({ event_name: event, ref }, { certify_launch_images: optIn }, (a, b) => a.startsWith(b));
}

test("candidate images require an explicit dispatch on only the isolated integration branch", () => {
  const candidate = "refs/heads/codex/launch-integration-certification";
  assert.equal(allowed("workflow_dispatch", candidate, true), true);
  for (const event of ["push", "pull_request", "workflow_dispatch"]) {
    assert.equal(allowed(event, candidate), false);
    assert.equal(allowed(event, "refs/heads/unrelated", true), false);
  }
  assert.equal(allowed("push", candidate, true), false);
  assert.equal(allowed("pull_request", candidate, true), false);
  for (const event of ["push", "workflow_dispatch"]) {
    assert.equal(allowed(event, "refs/heads/main"), true);
    assert.equal(allowed(event, "refs/tags/v1.2.3"), true);
  }
  assert.equal(allowed("pull_request", "refs/heads/main", true), false);
});

test("branch images have only the exact SHA tag and retain existing main and version tags", () => {
  const meta = images.match(/id: meta\n        run: \|\n([\s\S]*?)\n      - name:/u)[1];
  const tagging = meta.slice(0, meta.indexOf("          {\n")).replace(/\$\{\{ matrix.target \}\}/gu, "api");
  const sha = "a".repeat(40);
  for (const [ref, name, expected] of [
    ["refs/heads/codex/launch-integration-certification", "codex/launch-integration-certification", [sha]],
    ["refs/heads/main", "main", [sha, "latest"]],
    ["refs/tags/v1.2.3", "v1.2.3", [sha, "v1.2.3"]],
  ]) {
    const result = spawnSync("bash", ["-c", `${tagging}\nprintf '%s' "$tags"`], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY_OWNER: "Owner",
        REGISTRY: "ghcr.io",
        GITHUB_SHA: sha,
        GITHUB_REF: ref,
        GITHUB_REF_NAME: name,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stdout.split("\n"),
      expected.map((tag) => `ghcr.io/owner/matchday-api:${tag}`),
    );
  }
});

test("certification includes five ARM64 images, immutable provenance and operational source checks", () => {
  assert.deepEqual(
    [...images.matchAll(/- \{ target: (\w+),/gu)].map((m) => m[1]),
    ["api", "web", "worker", "migrate", "backup"],
  );
  assert.match(images, /platforms: linux\/arm64/u);
  assert.match(images, /provenance: mode=max/u);
  assert.match(images, /sbom: true/u);
  assert.match(images, /source_sha: e\.GITHUB_SHA/u);
  assert.match(images, /workflow_run_id: e\.GITHUB_RUN_ID/u);
  assert.match(images, /name: image-provenance-\$\{\{ matrix.target \}\}/u);
  assert.doesNotMatch(images, /run:.*(?:deploy-prod|ssh|kubectl)/u);
  const quality = source.slice(source.indexOf("\n  quality-fast:"), source.indexOf("\n  integration:"));
  for (const command of [
    "infra/oci/deploy-prod.test.mjs",
    "infra/oci/deployment-freeze-policy.test.mjs",
    "infra/oci/backup/backup.test.mjs",
    "scripts/launch-ci-contract.test.mjs",
    "MATCHDAY_REQUIRE_DOCKER_CADDY_TEST=1",
    "pnpm dependencies:audit",
    "RELEASE_PHASE=A",
  ]) {
    assert.ok(quality.includes(command), `Missing mandatory source gate: ${command}`);
  }
});
