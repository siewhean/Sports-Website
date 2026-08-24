import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScoringFallbackHmacKeyring, parseScoringFallbackHmacKeyring } from "@matchday/config";
import { C5_CONTROLLED_FAILURES } from "@matchday/observability";
import { createValidFallbackKeyring } from "../helpers/fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 13: Controlled Failure Drills & Key Rotations", () => {
  it("F13-T01: C5_CONTROLLED_FAILURES defines all 12 required failure injection hooks", () => {
    expect(C5_CONTROLLED_FAILURES).toContain("postgres_interruption");
    expect(C5_CONTROLLED_FAILURES).toContain("redis_interruption");
    expect(C5_CONTROLLED_FAILURES).toContain("api_interruption");
    expect(C5_CONTROLLED_FAILURES).toContain("web_interruption");
    expect(C5_CONTROLLED_FAILURES).toContain("worker_interruption");
    expect(C5_CONTROLLED_FAILURES).toContain("latency");
    expect(C5_CONTROLLED_FAILURES).toContain("connection_pressure");
    expect(C5_CONTROLLED_FAILURES).toContain("outbox_delay");
    expect(C5_CONTROLLED_FAILURES).toContain("disk_pressure");
    expect(C5_CONTROLLED_FAILURES).toContain("pdf_failure");
    expect(C5_CONTROLLED_FAILURES).toContain("backup_restore");
    expect(C5_CONTROLLED_FAILURES).toContain("projection_regeneration");
    expect(C5_CONTROLLED_FAILURES.length).toBe(12);
  });

  it("F13-T02: backup and restore verification keeps the guarded direct Docker-client path", () => {
    const scriptPath = path.join(rootDir, "scripts/verify-backup-restore.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("pg_dump");
    expect(content).toContain("pg_restore");
    expect(content).toContain('VERIFY_MODE="${BACKUP_VERIFY_MODE:-local}"');
    expect(content).toContain('DIRECT_CLIENT_IMAGE="${BACKUP_VERIFY_DIRECT_CLIENT_IMAGE:-postgres:18.4-alpine}"');
    expect(content).toContain('if [[ "$VERIFY_MODE" == "direct" ]]');
    expect(content).toContain(
      'docker run --rm --network host --volume "$DIRECT_BACKUP_DIRECTORY:/work" "$DIRECT_CLIENT_IMAGE"',
    );
    expect(content).toContain("assert_loopback_admin_url");
    expect(content).toContain("assert_disposable_name");
    expect(content).toContain("assert_direct_client_image");
  });

  it("F13-T03: parseScoringFallbackHmacKeyring parses valid primary and verificationOnly keys", () => {
    const keyring = createValidFallbackKeyring();
    const parsed = parseScoringFallbackHmacKeyring(keyring);
    expect(parsed.primary.version).toBe("v2-2026");
    expect(parsed.verificationOnly.length).toBe(1);
    expect(parsed.verificationOnly[0]!.version).toBe("v1-legacy");
  });

  it("F13-T04: loadScoringFallbackHmacKeyring falls back to v1 primary secret when no JSON keyring provided", () => {
    const legacySecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const result = loadScoringFallbackHmacKeyring(legacySecret, "test", {});
    expect(result.primary.version).toBe("v1");
    expect(result.primary.secret).toBe(legacySecret);
    expect(result.verificationOnly).toHaveLength(0);
  });

  it("F13-T05: scoring access HMAC keyring migration 0047 defines key versions table", () => {
    const migrationsDir = path.join(rootDir, "packages/database/migrations");
    const files = path.join(migrationsDir, "0047_gate_c_scoring_access_hmac_key_versions.sql");
    expect(existsSync(files)).toBe(true);
    const content = readFileSync(files, "utf8");
    expect(content).toContain("scoring_access_hmac_key_versions");
  });
});
