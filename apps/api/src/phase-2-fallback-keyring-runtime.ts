import { createHmac } from "node:crypto";
import type { ScoringFallbackHmacKey, ScoringFallbackHmacKeyring } from "@matchday/config/scoring-fallback-keyring";
import type { PostgresJsSql } from "@matchday/identity";
import {
  NoopScoringAccessRateLimiter,
  type ScoringAccessRateLimitHeaders,
  type ScoringAccessRateLimiter,
} from "./scoring-access-rate-limit.js";
import { Phase2Runtime, type Phase2DomainAdapter } from "./phase-2-runtime.js";

export type FallbackExchangeInput = Readonly<{
  token?: string;
  shortCode?: string;
  expectedMatchId?: string;
  deviceId?: string;
  deviceLabel?: string;
  ipAddress?: string;
}>;

type ExchangedScoringSession = Readonly<{
  session_id: string;
  session_token: string;
  match_id: string;
  mode: "writer" | "candidate" | "viewer" | "transferred";
  permissions: readonly ("score:read" | "score:write" | "score:reverse" | "score:finalise")[];
  generation: number | null;
  expires_at: string;
  lease_expires_at: string | null;
  rate_limit: ScoringAccessRateLimitHeaders;
}>;

type LegacyWriterExchange = ExchangedScoringSession & Readonly<{ mode: "writer"; generation: number }>;

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
    now: () => Date = () => new Date(),
    scoringAccessRateLimiter: ScoringAccessRateLimiter = new NoopScoringAccessRateLimiter(),
    private readonly fallbackKeyring: ScoringFallbackHmacKeyring,
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
    );
    const versions = [fallbackKeyring.primary.version, ...fallbackKeyring.verificationOnly.map((key) => key.version)];
    const secrets = [fallbackKeyring.primary.secret, ...fallbackKeyring.verificationOnly.map((key) => key.secret)];
    if (new Set(versions).size !== versions.length || new Set(secrets).size !== secrets.length) {
      throw new Error("Fallback-code HMAC keyring versions and key material must be unique");
    }
    for (const key of fallbackKeyring.verificationOnly) {
      this.delegates.set(
        key.version,
        new Phase2Runtime(
          keySql,
          domain,
          now,
          scoringAccessRateLimiter,
          key.secret,
          fallbackCodeGenerator,
          takeoverRequestTtlMs,
        ),
      );
    }
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
    if (rows.length > 1) {
      throw new Error("Presented fallback code is ambiguous across configured HMAC key versions");
    }
    const matchedHash = rows[0]?.hash_hex;
    if (!matchedHash) return this.fallbackKeyring.primary;
    const candidate = candidates.find(({ hashHex }) => hashHex === matchedHash);
    if (!candidate) throw new Error("Fallback-code HMAC resolver returned an unknown retained hash");
    return candidate.key;
  }

  async exchangeAccess(
    input: { token?: string; shortCode?: string; expectedMatchId?: string },
    requestId: string,
  ): Promise<LegacyWriterExchange>;
  async exchangeAccess(
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
  async exchangeAccess(input: FallbackExchangeInput, requestId: string): Promise<ExchangedScoringSession> {
    const key = input.shortCode
      ? await this.keyForPresentedFallbackCode(input.shortCode)
      : this.fallbackKeyring.primary;
    const delegate =
      key.version === this.fallbackKeyring.primary.version ? this : this.delegates.get(key.version);
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
