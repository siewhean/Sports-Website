import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  parseScoringFallbackHmacKeyring,
  loadScoringFallbackHmacKeyring,
  type ScoringFallbackHmacKeyring,
} from "@matchday/config";
import {
  fallbackCodeHashHex,
  fallbackCodeCandidates,
  selectFallbackCodeKey,
} from "../../../apps/api/src/phase-2-fallback-keyring-runtime";
import {
  reconcileScoringAccessHmacKeyring,
  retireScoringAccessHmacKeyVersion,
  scoringAccessHmacRetirementRedisTtlSeconds,
} from "../../../apps/api/src/scoring-access-hmac-keyring";
import {
  RedisScoringAccessRateLimiter,
  scoringAccessRateLimited,
  type ScoringAccessRateLimitHmacKeyring,
} from "../../../apps/api/src/scoring-access-rate-limit";
import {
  OfflineGrantSealer,
  InvalidOfflineGrantError,
  offlineGrantCookie,
  expiredOfflineGrantCookie,
  type OfflineGrantCredential,
} from "../../../apps/web/lib/offline-grant.server";
import { ApiError } from "../../../apps/api/src/errors";
import type { PostgresJsSql } from "@matchday/identity";

function sha256MaterialCommitment(secret: string): Buffer {
  return createHash("sha256")
    .update("matchday:scoring-access-hmac-key-material:v1:\u0000", "utf8")
    .update(secret, "utf8")
    .digest();
}

/**
 * High-fidelity in-memory PostgreSQL mock implementing the transaction, locking,
 * query filtering, and table updates required by scoring-access-hmac-keyring.ts.
 */
class MockPostgresKeyringDatabase {
  public keyVersions: Map<
    string,
    {
      key_version: string;
      material_commitment: Buffer;
      status: "primary" | "verification_only" | "retired";
      activated_at: Date;
      verification_only_since: Date | null;
      retirement_not_before: Date | null;
      retired_at: Date | null;
    }
  > = new Map();

  public platformRoles: {
    account_id: string;
    role: string;
    revoked_at: Date | null;
    expires_at: Date | null;
  }[] = [];

  public scoringAttempts: {
    id: string;
    hmac_key_version: string;
    rate_limit_state_expires_at: Date;
  }[] = [];

  public auditEvents: {
    action: string;
    target_id: string;
    actor_type: string;
    occurred_at: Date;
  }[] = [];

  public isLocked = false;

  asSql(): PostgresJsSql {
    const db = this;

    const txClient = {
      unsafe: async <T = any>(query: string, parameters: any[] = []): Promise<T[]> => {
        const normalized = query.trim().replace(/\s+/g, " ");

        if (normalized.includes("pg_advisory_xact_lock")) {
          db.isLocked = true;
          return [] as T[];
        }

        if (normalized.startsWith("SELECT key_version,material_commitment,status")) {
          const rows = Array.from(db.keyVersions.values()).sort((a, b) => a.key_version.localeCompare(b.key_version));
          return rows as unknown as T[];
        }

        if (normalized.startsWith("SELECT account_id FROM account_platform_roles")) {
          const accountId = parameters[0];
          const now = parameters[1] as Date;
          const matching = db.platformRoles.filter(
            (r) =>
              r.account_id === accountId &&
              r.role === "platform_admin" &&
              r.revoked_at === null &&
              (r.expires_at === null || r.expires_at > now),
          );
          return matching as unknown as T[];
        }

        if (normalized.startsWith("SELECT id FROM scoring_access_attempts")) {
          const keyVersion = parameters[0];
          const now = parameters[1] as Date;
          const matching = db.scoringAttempts.filter(
            (a) => a.hmac_key_version === keyVersion && a.rate_limit_state_expires_at > now,
          );
          return matching.slice(0, 1) as unknown as T[];
        }

        if (normalized.startsWith("INSERT INTO scoring_access_hmac_key_versions")) {
          const keyVersion = parameters[0];
          const commitment = parameters[1];
          const status = normalized.includes("'verification_only'") ? "verification_only" : "primary";
          const activatedAt = parameters[2];
          const retirementNotBefore = parameters[3] ?? null;

          db.keyVersions.set(keyVersion, {
            key_version: keyVersion,
            material_commitment: commitment,
            status,
            activated_at: activatedAt,
            verification_only_since: status === "verification_only" ? activatedAt : null,
            retirement_not_before: retirementNotBefore,
            retired_at: null,
          });
          return [] as T[];
        }

        if (
          normalized.startsWith(
            "UPDATE scoring_access_hmac_key_versions SET material_commitment=$2 WHERE key_version=$1",
          )
        ) {
          const keyVersion = parameters[0];
          const commitment = parameters[1];
          const existing = db.keyVersions.get(keyVersion);
          if (existing) {
            existing.material_commitment = commitment;
          }
          return [] as T[];
        }

        if (normalized.startsWith("UPDATE scoring_access_hmac_key_versions SET status='verification_only'")) {
          const keyVersion = parameters[0];
          const now = parameters[1] as Date;
          const retirementNotBefore = parameters[2] as Date;
          const existing = db.keyVersions.get(keyVersion);
          if (existing) {
            existing.status = "verification_only";
            existing.verification_only_since = now;
            existing.retirement_not_before = retirementNotBefore;
            existing.retired_at = null;
          }
          return [] as T[];
        }

        if (normalized.startsWith("UPDATE scoring_access_hmac_key_versions SET status='primary'")) {
          const keyVersion = parameters[0];
          const existing = db.keyVersions.get(keyVersion);
          if (existing) {
            existing.status = "primary";
            existing.verification_only_since = null;
            existing.retirement_not_before = null;
            existing.retired_at = null;
          }
          return [] as T[];
        }

        if (normalized.startsWith("UPDATE scoring_access_hmac_key_versions SET status='retired'")) {
          const keyVersion = parameters[0];
          const now = parameters[1] as Date;
          const existing = db.keyVersions.get(keyVersion);
          if (existing) {
            existing.status = "retired";
            existing.retired_at = now;
          }
          return [] as T[];
        }

        if (normalized.startsWith("INSERT INTO audit_events")) {
          const occurredAt = parameters[0];
          const actionMatch = normalized.match(/'scoring_access_hmac_key\.[a-z_]+'/);
          const action = actionMatch ? actionMatch[0].replaceAll("'", "") : (parameters[2] ?? "unknown");
          const targetId = parameters[3] ?? "target";
          db.auditEvents.push({
            action,
            target_id: targetId,
            actor_type: normalized.includes("'system'") ? "system" : "platform_admin",
            occurred_at: occurredAt,
          });
          return [] as T[];
        }

        throw new Error(`Unhandled mock query: ${query}`);
      },
    };

    return {
      begin: async <T>(cb: (tx: any) => Promise<T>): Promise<T> => {
        try {
          return await cb(txClient);
        } finally {
          db.isLocked = false;
        }
      },
      unsafe: txClient.unsafe,
    } as unknown as PostgresJsSql;
  }
}

describe("Tier 5 Adversarial - Subsystem 4: Scoring Access & HMAC Keyrings Hardening", () => {
  describe("1. Expired, Retired & Malformed Key Configuration Fences", () => {
    it("ADV-HMAC-01: rejects fallback keyring with invalid format or secret length < 32 bytes", () => {
      expect(() => loadScoringFallbackHmacKeyring("short-secret-under-32-bytes", "test", {})).toThrow(
        "Scoring fallback-code HMAC primary must contain at least 32 bytes",
      );

      expect(() =>
        loadScoringFallbackHmacKeyring("a".repeat(32), "production", {
          SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: "not-json",
        }),
      ).toThrow("SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING must be valid JSON");

      expect(() =>
        loadScoringFallbackHmacKeyring("a".repeat(32), "production", {
          SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING: JSON.stringify({
            primary: { version: "v1", secret: "a".repeat(32) },
            verificationOnly: [{ version: "v2", secret: "b".repeat(32) }],
          }),
        }),
      ).toThrow("A deployed rotating fallback-code keyring must use a new primary version instead of v1");
    });

    it("ADV-HMAC-02: rejects duplicate fallback keyring versions or duplicate key material", () => {
      const duplicateVersionsPayload = {
        primary: { version: "v2", secret: "0123456789abcdef0123456789abcdef" },
        verificationOnly: [{ version: "v2", secret: "fedcba9876543210fedcba9876543210" }],
      };
      expect(() => parseScoringFallbackHmacKeyring(duplicateVersionsPayload)).toThrow(
        "Fallback-code HMAC key versions must be unique",
      );

      const duplicateMaterialPayload = {
        primary: { version: "v2", secret: "0123456789abcdef0123456789abcdef" },
        verificationOnly: [
          { version: "v1", secret: "0123456789abcdef0123456789abcdef" }, // Same secret!
        ],
      };
      expect(() => parseScoringFallbackHmacKeyring(duplicateMaterialPayload)).toThrow(
        "Fallback-code HMAC key material must be unique",
      );
    });

    it("ADV-HMAC-03: enforces max limit of 7 verification-only keys (total 8 keys)", () => {
      const eightVerificationKeys = Array.from({ length: 8 }, (_, i) => ({
        version: `v${i + 1}`,
        secret: `secret_material_value_number_${i}_padded_to_32_bytes_min`,
      }));

      const payload = {
        primary: { version: "v0", secret: "primary_secret_material_padded_to_32_bytes_min" },
        verificationOnly: eightVerificationKeys,
      };

      expect(() => parseScoringFallbackHmacKeyring(payload)).toThrow();
    });

    it("ADV-HMAC-04: rejects configured keyring that omits an existing active unretired key", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const legacySecret = "legacy_secret_material_32_bytes_long";
      const legacyCommitment = sha256MaterialCommitment(legacySecret);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: legacyCommitment,
        status: "primary",
        activated_at: now,
        verification_only_since: null,
        retirement_not_before: null,
        retired_at: null,
      });

      // Configured keyring only defines v2, omitting v1 which is still active in DB!
      const keyring: ScoringAccessRateLimitHmacKeyring = {
        primary: { version: "v2", secret: "new_primary_secret_material_32_bytes_long" },
        verificationOnly: [],
      };

      await expect(reconcileScoringAccessHmacKeyring(db.asSql(), keyring, now)).rejects.toThrow(
        "Configured scoring access HMAC keyring omits non-retired key version v1; retire it explicitly first.",
      );
    });

    it("ADV-HMAC-05: rejects configuring a key version that has already been retired in registry", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const retiredSecret = "retired_secret_material_32_bytes_long";
      const retiredCommitment = sha256MaterialCommitment(retiredSecret);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: retiredCommitment,
        status: "retired",
        activated_at: new Date(now.getTime() - 86400_000),
        verification_only_since: new Date(now.getTime() - 43200_000),
        retirement_not_before: new Date(now.getTime() - 3600_000),
        retired_at: new Date(now.getTime() - 1800_000),
      });

      const keyring: ScoringAccessRateLimitHmacKeyring = {
        primary: { version: "v2", secret: "new_primary_secret_material_32_bytes_long" },
        verificationOnly: [{ version: "v1", secret: retiredSecret }],
      };

      await expect(reconcileScoringAccessHmacKeyring(db.asSql(), keyring, now)).rejects.toThrow(
        "Configured scoring access HMAC key version v1 is retired.",
      );
    });

    it("ADV-HMAC-06: detects and blocks key material mismatch on existing key version", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const originalSecret = "original_secret_material_32_bytes_long";
      const originalCommitment = sha256MaterialCommitment(originalSecret);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: originalCommitment,
        status: "primary",
        activated_at: now,
        verification_only_since: null,
        retirement_not_before: null,
        retired_at: null,
      });

      const tamperedKeyring: ScoringAccessRateLimitHmacKeyring = {
        primary: { version: "v1", secret: "tampered_different_secret_32_bytes_long" },
        verificationOnly: [],
      };

      await expect(reconcileScoringAccessHmacKeyring(db.asSql(), tamperedKeyring, now)).rejects.toThrow(
        "Configured scoring access HMAC key version v1 has different key material.",
      );
    });
  });

  describe("2. Key Retirement Fences & RBAC Fences", () => {
    it("ADV-HMAC-07: rejects key retirement when caller lacks platform_admin platform role", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();

      await expect(
        retireScoringAccessHmacKeyVersion(
          db.asSql(),
          {
            keyVersion: "v1",
            accountId: randomUUID(),
            requestId: "req-unauth-01",
            reason: "Attempt unauthorized retirement",
          },
          now,
        ),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "PLATFORM_ADMIN_REQUIRED",
      });
    });

    it("ADV-HMAC-08: rejects retirement of primary active key (must transition to verification_only first)", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const adminId = randomUUID();
      db.platformRoles.push({
        account_id: adminId,
        role: "platform_admin",
        revoked_at: null,
        expires_at: null,
      });

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: sha256MaterialCommitment("secret_32_bytes_long_111111111111"),
        status: "primary",
        activated_at: now,
        verification_only_since: null,
        retirement_not_before: null,
        retired_at: null,
      });

      await expect(
        retireScoringAccessHmacKeyVersion(
          db.asSql(),
          {
            keyVersion: "v1",
            accountId: adminId,
            requestId: "req-retire-primary-01",
            reason: "Retire active primary",
          },
          now,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "SCORING_ACCESS_HMAC_KEY_VERSION_PRIMARY",
      });
    });

    it("ADV-HMAC-09: blocks key retirement before Redis TTL cooldown expiry (15 minutes)", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const adminId = randomUUID();
      db.platformRoles.push({
        account_id: adminId,
        role: "platform_admin",
        revoked_at: null,
        expires_at: null,
      });

      // Key demoted to verification_only just 5 minutes ago (requires 15 min TTL)
      const demotedAt = new Date(now.getTime() - 5 * 60 * 1_000);
      const retirementNotBefore = new Date(demotedAt.getTime() + scoringAccessHmacRetirementRedisTtlSeconds * 1_000);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: sha256MaterialCommitment("secret_32_bytes_long_111111111111"),
        status: "verification_only",
        activated_at: new Date(now.getTime() - 3600_000),
        verification_only_since: demotedAt,
        retirement_not_before: retirementNotBefore,
        retired_at: null,
      });

      await expect(
        retireScoringAccessHmacKeyVersion(
          db.asSql(),
          {
            keyVersion: "v1",
            accountId: adminId,
            requestId: "req-retire-pending-01",
            reason: "Premature retirement before TTL",
          },
          now,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "SCORING_ACCESS_HMAC_KEY_VERSION_RETENTION_PENDING",
      });
    });

    it("ADV-HMAC-10: blocks key retirement while active scoring access attempt state exists", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const adminId = randomUUID();
      db.platformRoles.push({
        account_id: adminId,
        role: "platform_admin",
        revoked_at: null,
        expires_at: null,
      });

      // Retention passed (demoted 20 minutes ago)
      const demotedAt = new Date(now.getTime() - 20 * 60 * 1_000);
      const retirementNotBefore = new Date(demotedAt.getTime() + scoringAccessHmacRetirementRedisTtlSeconds * 1_000);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: sha256MaterialCommitment("secret_32_bytes_long_111111111111"),
        status: "verification_only",
        activated_at: new Date(now.getTime() - 3600_000),
        verification_only_since: demotedAt,
        retirement_not_before: retirementNotBefore,
        retired_at: null,
      });

      // Active access attempt retaining rate limit state on v1
      db.scoringAttempts.push({
        id: randomUUID(),
        hmac_key_version: "v1",
        rate_limit_state_expires_at: new Date(now.getTime() + 10 * 60 * 1_000), // Expires in +10m
      });

      await expect(
        retireScoringAccessHmacKeyVersion(
          db.asSql(),
          {
            keyVersion: "v1",
            accountId: adminId,
            requestId: "req-retire-active-attempt-01",
            reason: "Retirement with active attempts",
          },
          now,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "SCORING_ACCESS_HMAC_KEY_VERSION_ACTIVE_STATE",
      });
    });

    it("ADV-HMAC-11: cleanly retires key after TTL passes and no active attempts remain", async () => {
      const db = new MockPostgresKeyringDatabase();
      const now = new Date();
      const adminId = randomUUID();
      db.platformRoles.push({
        account_id: adminId,
        role: "platform_admin",
        revoked_at: null,
        expires_at: null,
      });

      const demotedAt = new Date(now.getTime() - 20 * 60 * 1_000);
      const retirementNotBefore = new Date(demotedAt.getTime() + scoringAccessHmacRetirementRedisTtlSeconds * 1_000);

      db.keyVersions.set("v1", {
        key_version: "v1",
        material_commitment: sha256MaterialCommitment("secret_32_bytes_long_111111111111"),
        status: "verification_only",
        activated_at: new Date(now.getTime() - 3600_000),
        verification_only_since: demotedAt,
        retirement_not_before: retirementNotBefore,
        retired_at: null,
      });

      await retireScoringAccessHmacKeyVersion(
        db.asSql(),
        {
          keyVersion: "v1",
          accountId: adminId,
          requestId: "req-retire-success-01",
          reason: "Completed retention window",
        },
        now,
      );

      const retiredRow = db.keyVersions.get("v1");
      expect(retiredRow?.status).toBe("retired");
      expect(retiredRow?.retired_at).toEqual(now);
      expect(db.auditEvents.some((e) => e.action === "scoring_access_hmac_key.retired")).toBe(true);
    });
  });

  describe("3. Fallback Code Resolver & Ambiguity Attack Fences", () => {
    it("ADV-HMAC-12: resolves matching key among candidate verification keys", () => {
      const keyring: ScoringFallbackHmacKeyring = {
        primary: { version: "v2", secret: "0123456789abcdef0123456789abcdef" },
        verificationOnly: [{ version: "v1", secret: "fedcba9876543210fedcba9876543210" }],
      };

      const shortCode = "123456789012";
      const candidates = fallbackCodeCandidates(shortCode, keyring);
      expect(candidates).toHaveLength(2);

      const v1Hash = fallbackCodeHashHex(shortCode, keyring.verificationOnly[0]!.secret);
      const selected = selectFallbackCodeKey(candidates, [v1Hash], keyring.primary);
      expect(selected.version).toBe("v1");
      expect(selected.secret).toBe(keyring.verificationOnly[0]!.secret);
    });

    it("ADV-HMAC-13: detects and rejects ambiguous fallback code matching multiple key versions", () => {
      const keyring: ScoringFallbackHmacKeyring = {
        primary: { version: "v2", secret: "0123456789abcdef0123456789abcdef" },
        verificationOnly: [{ version: "v1", secret: "fedcba9876543210fedcba9876543210" }],
      };

      const shortCode = "123456789012";
      const candidates = fallbackCodeCandidates(shortCode, keyring);

      expect(() =>
        selectFallbackCodeKey(
          candidates,
          [candidates[0]!.hashHex, candidates[1]!.hashHex], // Matched both hashes!
          keyring.primary,
        ),
      ).toThrow("Presented fallback code is ambiguous across configured HMAC key versions");
    });

    it("ADV-HMAC-14: rejects unknown retained hash from resolver", () => {
      const keyring: ScoringFallbackHmacKeyring = {
        primary: { version: "v2", secret: "0123456789abcdef0123456789abcdef" },
        verificationOnly: [],
      };

      const candidates = fallbackCodeCandidates("123456789012", keyring);
      expect(() => selectFallbackCodeKey(candidates, ["unrecognized_unknown_hash_hex"], keyring.primary)).toThrow(
        "Fallback-code HMAC resolver returned an unknown retained hash",
      );
    });
  });

  describe("4. AES-256-GCM Offline Grant Sealer Security & Replay Fences", () => {
    const validSealKey = Buffer.alloc(32, 0x42).toString("base64url");
    const testNow = 1750000000000;

    it("ADV-HMAC-15: rejects sealing credentials with expired replay timestamp", () => {
      const sealer = new OfflineGrantSealer(validSealKey, () => testNow);
      const expiredCredential: OfflineGrantCredential = {
        authorizationId: randomUUID(),
        matchId: randomUUID(),
        resumeSecret: "secret_resume_key_string_of_sufficient_length_43_chars_minimum_ok",
        replayExpiresAt: new Date(testNow - 1000).toISOString(), // Expired!
      };

      expect(() => sealer.seal(expiredCredential)).toThrow(InvalidOfflineGrantError);
    });

    it("ADV-HMAC-16: detects bit-flipped ciphertext or corrupted auth tag", () => {
      const sealer = new OfflineGrantSealer(validSealKey, () => testNow);
      const credential: OfflineGrantCredential = {
        authorizationId: randomUUID(),
        matchId: randomUUID(),
        resumeSecret: "secret_resume_key_string_of_sufficient_length_43_chars_minimum_ok",
        replayExpiresAt: new Date(testNow + 3600_000).toISOString(),
      };

      const sealed = sealer.seal(credential);
      const [iv, ciphertext, tag] = sealed.split(".");

      // 1. Bit flip in ciphertext
      const corruptedCiphertext = Buffer.from(ciphertext!, "base64url");
      corruptedCiphertext[0]! ^= 0xff;
      const tamperedCiphertextCookie = `${iv}.${corruptedCiphertext.toString("base64url")}.${tag}`;
      expect(() => sealer.open(tamperedCiphertextCookie)).toThrow(InvalidOfflineGrantError);

      // 2. Bit flip in auth tag
      const corruptedTag = Buffer.from(tag!, "base64url");
      corruptedTag[0]! ^= 0xff;
      const tamperedTagCookie = `${iv}.${ciphertext}.${corruptedTag.toString("base64url")}`;
      expect(() => sealer.open(tamperedTagCookie)).toThrow(InvalidOfflineGrantError);

      // 3. Truncated IV (11 bytes instead of 12)
      const truncatedIv = Buffer.alloc(11, 1).toString("base64url");
      const truncatedIvCookie = `${truncatedIv}.${ciphertext}.${tag}`;
      expect(() => sealer.open(truncatedIvCookie)).toThrow(InvalidOfflineGrantError);
    });

    it("ADV-HMAC-17: rejects replayed token after clock moves past replay expiration", () => {
      let currentClock = testNow;
      const sealer = new OfflineGrantSealer(validSealKey, () => currentClock);
      const credential: OfflineGrantCredential = {
        authorizationId: randomUUID(),
        matchId: randomUUID(),
        resumeSecret: "secret_resume_key_string_of_sufficient_length_43_chars_minimum_ok",
        replayExpiresAt: new Date(testNow + 60_000).toISOString(), // Valid for 1 minute
      };

      const token = sealer.seal(credential);
      expect(sealer.open(token)).toMatchObject({ authorizationId: credential.authorizationId });

      // Fast forward clock past expiry (replayed after 2 minutes)
      currentClock += 120_000;
      expect(() => sealer.open(token)).toThrow(InvalidOfflineGrantError);
    });

    it("ADV-HMAC-18: cookie serializer generates strict Max-Age and expired header", () => {
      const expiry = new Date(testNow + 300_000).toISOString();
      const cookieHeader = offlineGrantCookie("sealed_token_sample", expiry, testNow);
      expect(cookieHeader).toContain("Max-Age=300");
      expect(cookieHeader).toContain("SameSite=Strict");
      expect(cookieHeader).toContain("HttpOnly");
      expect(cookieHeader).toContain("Secure");

      const expiredHeader = expiredOfflineGrantCookie();
      expect(expiredHeader).toContain("Max-Age=0");
      expect(expiredHeader).toContain("1970");
    });
  });
});
