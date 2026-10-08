import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

const PINNED_CADDY_IMAGE = "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const TIMEOUT_MS = 15000;

test("Docker-backed: Caddy directory bind-mount atomic replacement visibility", async (t) => {
  const strictMode = process.env.MATCHDAY_REQUIRE_DOCKER_CADDY_TEST === "1";

  // Check if docker daemon is reachable with hard timeout
  try {
    execFileSync("docker", ["version"], { stdio: "ignore", timeout: TIMEOUT_MS });
  } catch (err) {
    if (strictMode) {
      assert.fail(`MATCHDAY_REQUIRE_DOCKER_CADDY_TEST=1 is active but Docker daemon is unavailable: ${err.message}`);
    } else {
      t.skip("Docker daemon unavailable; skipping Docker-backed visibility test");
      return;
    }
  }

  const containerName = `caddy-visibility-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const rawTempDir = path.join("/tmp", containerName);
  mkdirSync(rawTempDir, { recursive: true });
  const tempDir = realpathSync(rawTempDir);

  const caddyfileInitial = `:8080 {\n  respond "matchday-v1"\n}\n`;
  const caddyfileUpdated = `:8080 {\n  respond "matchday-v2"\n}\n`;
  const caddyfileRollback = `:8080 {\n  respond "matchday-v1-restored"\n}\n`;

  const hostCaddyfile = path.join(tempDir, "Caddyfile");
  const hostCandidate = path.join(tempDir, ".Caddyfile.candidate");
  const hostRollback = path.join(tempDir, ".Caddyfile.previous");

  writeFileSync(hostCaddyfile, caddyfileInitial);

  let containerStarted = false;
  try {
    // Start Caddy container mounting directory to /etc/caddy:ro
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "--rm",
        "-v",
        `${tempDir}:/etc/caddy:ro`,
        PINNED_CADDY_IMAGE,
        "caddy",
        "run",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ],
      { stdio: "pipe", timeout: TIMEOUT_MS },
    );
    containerStarted = true;

    // Wait briefly for caddy startup
    let started = false;
    for (let i = 0; i < 20; i++) {
      try {
        const out = execFileSync("docker", ["exec", containerName, "caddy", "version"], {
          encoding: "utf8",
          timeout: TIMEOUT_MS,
        });
        if (out.includes("v2")) {
          started = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(started, "Caddy container failed to start in test timeout");

    // 1. Verify directory bind mount configuration via inspect
    const inspectMounts = execFileSync(
      "docker",
      ["inspect", containerName, "--format", "{{range .Mounts}}{{println .Type .Source .Destination .RW}}{{end}}"],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    const hasDirMount = inspectMounts
      .trim()
      .split("\n")
      .some((line) => {
        const parts = line.trim().split(/\s+/);
        return (
          parts[0] === "bind" && parts[1] === tempDir && parts[2] === "/etc/caddy" && parts[3].toLowerCase() === "false"
        );
      });
    assert.ok(hasDirMount, `Container must have read-only directory bind mount matching ${tempDir}:/etc/caddy:ro`);

    // 2. Initial configuration and HTTP check inside container
    const initialRead = execFileSync("docker", ["exec", containerName, "cat", "/etc/caddy/Caddyfile"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(initialRead, caddyfileInitial, "Initial config must be visible in container");

    const initialHttp = execFileSync("docker", ["exec", containerName, "wget", "-qO-", "http://127.0.0.1:8080/"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(initialHttp.trim(), "matchday-v1", "Initial HTTP response must be matchday-v1");

    // 3. Atomic host rename: write candidate in same directory and atomic rename (mv -f)
    writeFileSync(hostCandidate, caddyfileUpdated);
    execFileSync("mv", ["-f", hostCandidate, hostCaddyfile]);
    assert.equal(existsSync(hostCandidate), false, "Candidate file must be moved");
    assert.equal(existsSync(hostCaddyfile), true, "Target file must exist");

    // 4. RUNNING_CONTAINER_SEES_NEW_CONFIG: container sees new config without restart
    let postRenameRead = "";
    for (let i = 0; i < 30; i++) {
      try {
        postRenameRead = execFileSync("docker", ["exec", containerName, "cat", "/etc/caddy/Caddyfile"], {
          encoding: "utf8",
          timeout: TIMEOUT_MS,
        });
        if (postRenameRead === caddyfileUpdated) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(postRenameRead, caddyfileUpdated, "Running container must see new config via directory mount");

    // 5. CADDY_RELOAD_USES_NEW_CONFIG: caddy reload loads new config successfully
    execFileSync("docker", ["exec", containerName, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });

    // 6. HTTP behavior proves newly applied configuration is active
    const postPromotionHttp = execFileSync(
      "docker",
      ["exec", containerName, "wget", "-qO-", "http://127.0.0.1:8080/"],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    assert.equal(postPromotionHttp.trim(), "matchday-v2", "Post-reload HTTP response must be matchday-v2");

    // 7. ROLLBACK_RESTORES_VISIBLE_OLD_CONFIG: atomic rollback restores previous config and caddy reloads
    writeFileSync(hostRollback, caddyfileRollback);
    execFileSync("mv", ["-f", hostRollback, hostCaddyfile]);
    let postRollbackRead = "";
    for (let i = 0; i < 30; i++) {
      try {
        postRollbackRead = execFileSync("docker", ["exec", containerName, "cat", "/etc/caddy/Caddyfile"], {
          encoding: "utf8",
          timeout: TIMEOUT_MS,
        });
        if (postRollbackRead === caddyfileRollback) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(postRollbackRead, caddyfileRollback, "Running container must see rolled-back config");

    execFileSync("docker", ["exec", containerName, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });

    // 8. HTTP behavior proves rolled-back configuration is active
    const postRollbackHttp = execFileSync("docker", ["exec", containerName, "wget", "-qO-", "http://127.0.0.1:8080/"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(
      postRollbackHttp.trim(),
      "matchday-v1-restored",
      "Post-rollback HTTP response must be matchday-v1-restored",
    );
  } finally {
    if (containerStarted) {
      try {
        execFileSync("docker", ["stop", containerName], { stdio: "ignore", timeout: TIMEOUT_MS });
      } catch {}
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
