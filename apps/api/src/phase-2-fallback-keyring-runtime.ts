import { createHmac } from "node:crypto";
import {
  parseScoringFallbackHmacKeyring,
  type ScoringFallbackHmacKey,
  type ScoringFallbackHmacKeyring,
} from "@matchday/config";
import type { PostgresJsSql } from "@matchday/identity";
import {
  NoopScoringAccessRateLimiter,
  type ScoringAccessRateLimitHeaders,
  type ScoringAccessRateLimiter,
} from "./scoring-access-rate-limit.js";
import { ApiError, ErrorCode } from "./errors.js";
import { Phase2Runtime, type Phase2DomainAdapter } from "./phase-2-runtime.js";

export type FallbackExchangeInput = {
  token?: string;
  shortCode?: string;
  expectedMatchId?: string;
  deviceId?: string;
  deviceLabel?: string;
  ipAddress?: string;
};

type ExchangedScoringSession = {
  session_id: string;
  session_token: string;
  match_id: string;
  mode: "writer" | "candidate" | "viewer" | "transferred";
  permissions: ("score:read" | "score:write" | "score:reverse" | "score:finalise")[];
  generation: number | null;
  expires_at: string;
  lease_expires_at: string | null;
  rate_limit: ScoringAccessRateLimitHeaders;
};

type LegacyWriterExchange = ExchangedScoringSession & { mode: "writer"; generation: number };

export type FallbackCodeCandidate = Readonly<{
  key: ScoringFallbackHmacKey;
  hashHex: string;
}>;

export function fallbackCodeHashHex(shortCode: string, secret: string): string {
  return createHmac("sha256", secret).update(`scoring-fallback-code:${shortCode}`, "utf8").digest("hex");
}

export function fallbackCodeCandidates(
  shortCode: string,
  keyring: ScoringFallbackHmacKeyring,
): readonly FallbackCodeCandidate[] {
  return [keyring.primary, ...keyring.verificationOnly].map((key) => ({
    key,
    hashHex: fallbackCodeHashHex(shortCode, key.secret),
  }));
}

export function selectFallbackCodeKey(
  candidates: readonly FallbackCodeCandidate[],
  matchedHashes: readonly string[],
  primary: ScoringFallbackHmacKey,
): ScoringFallbackHmacKey {
  if (matchedHashes.length > 1) {
    throw new Error("Presented fallback code is ambiguous across configured HMAC key versions");
  }
  const matchedHash = matchedHashes[0];
  if (!matchedHash) return primary;
  const candidate = candidates.find(({ hashHex }) => hashHex === matchedHash);
  if (!candidate) throw new Error("Fallback-code HMAC resolver returned an unknown retained hash");
  return candidate.key;
}

async function assertDurableFallbackCodeHmacKeyVersion(
  purpose: "issue" | "verify",
  tx: PostgresJsSql,
  keyVersion: string,
): Promise<void> {
  const row = (
    await tx.unsafe<{ status: "primary" | "verification_only" | "retired" }>(
      "SELECT status FROM scoring_fallback_code_hmac_key_versions WHERE key_version=$1 FOR SHARE",
      [keyVersion],
    )
  )[0];
  if (purpose === "issue" && row?.status === "primary") return;
  if (purpose === "verify" && (row?.status === "primary" || row?.status === "verification_only")) return;
  const code =
    row?.status === "retired"
      ? "FALLBACK_HMAC_KEY_VERSION_RETIRED"
      : row
        ? "FALLBACK_HMAC_KEY_VERSION_ACTIVE_STATE"
        : "FALLBACK_HMAC_KEY_VERSION_UNKNOWN";
  const message =
    purpose === "issue"
      ? "Fallback-code HMAC key version is not an active primary version"
      : "Fallback-code HMAC key version is unavailable for verification";
  throw new ApiError(purpose === "issue" ? 409 : 403, ErrorCode[code], message);
}

/**
 * Verification-only key material is deliberately retained in memory so an
 * overlap window can validate codes minted by the previous primary. It must
 * still consult the durable registry inside the delegate's exchange
 * transaction: possessing an old secret is not authorization to use it.
 */
class DurableGuardedFallbackVerificationRuntime extends Phase2Runtime {
  constructor(
    sql: PostgresJsSql,
    domain: Phase2DomainAdapter,
    now: () => Date,
    scoringAccessRateLimiter: ScoringAccessRateLimiter,
    fallbackCodeHmacSecret: string,
    fallbackCodeGenerator: (() => string) | undefined,
    takeoverRequestTtlMs: number | undefined,
    fallbackCodeHmacKeyVersion: string,
  ) {
    super(
      sql,
      domain,
      now,
      scoringAccessRateLimiter,
      fallbackCodeHmacSecret,
      fallbackCodeGenerator,
      takeoverRequestTtlMs,
      fallbackCodeHmacKeyVersion,
    );
  }

  protected override assertFallbackCodeHmacKeyVersion(purpose: "issue" | "verify", tx: PostgresJsSql): Promise<void> {
    return assertDurableFallbackCodeHmacKeyVersion(purpose, tx, this.fallbackCodeHmacKeyVersion);
  }
}

/**
 * Phase2Runtime remains the single authority for credential validation,
 * rate-limiting, session issuance, audit, and writer fencing. This subclass
 * only selects which configured fallback-code HMAC key is needed to reproduce
 * a retained hash, then delegates exactly once to the ordinary runtime.
 */
export class FallbackKeyringPhase2Runtime extends Phase2Runtime {
  private readonly delegates = new Map<string, Phase2Runtime>();

  constructor(
    private readonly keySql: PostgresJsSql,
    domain: Phase2DomainAdapter,
    private readonly fallbackKeyring: ScoringFallbackHmacKeyring,
    now: () => Date = () => new Date(),
    scoringAccessRateLimiter: ScoringAccessRateLimiter = new NoopScoringAccessRateLimiter(),
    fallbackCodeGenerator?: () => string,
    takeoverRequestTtlMs?: number,
  ) {
    super(
      keySql,
      domain,
      now,
      scoringAccessRateLimiter,
      fallbackKeyring.primary.secret,
      fallbackCodeGenerator,
      takeoverRequestTtlMs,
      fallbackKeyring.primary.version,
    );
    parseScoringFallbackHmacKeyring(fallbackKeyring);
    for (const key of fallbackKeyring.verificationOnly) {
      this.delegates.set(
        key.version,
        new DurableGuardedFallbackVerificationRuntime(
          keySql,
          domain,
          now,
          scoringAccessRateLimiter,
          key.secret,
          fallbackCodeGenerator,
          takeoverRequestTtlMs,
          key.version,
        ),
      );
    }
  }

  /**
   * The configured keyring is immutable for the process lifetime, whereas the
   * durable registry can be promoted or retired by another instance. Consult
   * that registry within every fallback-code transaction so an old process
   * cannot keep issuing with a demoted primary or validating a retired key.
   */
  protected override async assertFallbackCodeHmacKeyVersion(
    purpose: "issue" | "verify",
    tx: PostgresJsSql,
  ): Promise<void> {
    return assertDurableFallbackCodeHmacKeyVersion(purpose, tx, this.fallbackCodeHmacKeyVersion);
  }

  private async keyForPresentedFallbackCode(shortCode: string): Promise<ScoringFallbackHmacKey> {
    if (!/^\d{12}$/u.test(shortCode) || this.fallbackKeyring.verificationOnly.length === 0) {
      return this.fallbackKeyring.primary;
    }
    const candidates = fallbackCodeCandidates(shortCode, this.fallbackKeyring);
    const hashes = candidates.map((candidate) => candidate.hashHex);
    const rows = await this.keySql.unsafe<{ hash_hex: string }>(
      `SELECT encode(short_code_hash,'hex') AS hash_hex
       FROM scoring_access_passes
       WHERE short_code_hash IS NOT NULL
         AND encode(short_code_hash,'hex')=ANY($1::text[])
       LIMIT 2`,
      [hashes],
    );
    return selectFallbackCodeKey(
      candidates,
      rows.map((row) => row.hash_hex),
      this.fallbackKeyring.primary,
    );
  }

  override async exchangeAccess(
    input: { token?: string; shortCode?: string; expectedMatchId?: string },
    requestId: string,
  ): Promise<LegacyWriterExchange>;
  override async exchangeAccess(
    input: {
      token?: string;
      shortCode?: string;
      expectedMatchId?: string;
      deviceId: string;
      deviceLabel?: string;
      ipAddress?: string;
    },
    requestId: string,
  ): Promise<ExchangedScoringSession>;
  override async exchangeAccess(input: FallbackExchangeInput, requestId: string): Promise<ExchangedScoringSession> {
    const key = input.shortCode
      ? await this.keyForPresentedFallbackCode(input.shortCode)
      : this.fallbackKeyring.primary;
    const delegate = key.version === this.fallbackKeyring.primary.version ? this : this.delegates.get(key.version);
    if (key.version !== this.fallbackKeyring.primary.version && !delegate) {
      throw new Error("Fallback-code HMAC verification runtime is unavailable");
    }

    if (input.deviceId !== undefined) {
      const deviceInput = {
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(input.shortCode !== undefined ? { shortCode: input.shortCode } : {}),
        ...(input.expectedMatchId !== undefined ? { expectedMatchId: input.expectedMatchId } : {}),
        deviceId: input.deviceId,
        ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      };
      return key.version === this.fallbackKeyring.primary.version
        ? super.exchangeAccess(deviceInput, requestId)
        : delegate!.exchangeAccess(deviceInput, requestId);
    }

    const legacyInput = {
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.shortCode !== undefined ? { shortCode: input.shortCode } : {}),
      ...(input.expectedMatchId !== undefined ? { expectedMatchId: input.expectedMatchId } : {}),
    };
    return key.version === this.fallbackKeyring.primary.version
      ? super.exchangeAccess(legacyInput, requestId)
      : delegate!.exchangeAccess(legacyInput, requestId);
  }
}
