import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const COOKIE_VERSION = 2;
const COOKIE_AAD = Buffer.from("matchday-scoring-session-v2", "utf8");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const scoringSessionCookieName = "__Host-matchday-scoring-session";

export type ScoringServerAuth = {
  sessionId: string;
  sessionToken: string;
  mode: "writer" | "candidate" | "viewer" | "transferred";
  permissions: string[];
  generation: number | null;
  matchId: string;
  expiresAt: string;
  leaseExpiresAt: string | null;
};

type SealedScoringServerAuth = ScoringServerAuth & { version: number };

export class InvalidScoringSessionError extends Error {
  constructor() {
    super("Scoring session is unavailable.");
    this.name = "InvalidScoringSessionError";
  }
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    throw new Error("SCORING_SESSION_SEAL_KEY must be the base64url encoding of exactly 32 random bytes.");
  }
  return key;
}

function expiresAtMs(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isValidAuth(value: unknown, now: number): value is SealedScoringServerAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Partial<SealedScoringServerAuth>;
  const expiry = typeof auth.expiresAt === "string" ? expiresAtMs(auth.expiresAt) : null;
  return (
    auth.version === COOKIE_VERSION &&
    typeof auth.sessionId === "string" &&
    UUID_PATTERN.test(auth.sessionId) &&
    typeof auth.sessionToken === "string" &&
    auth.sessionToken.length >= 32 &&
    auth.sessionToken.length <= 256 &&
    (auth.generation === null ||
      (typeof auth.generation === "number" && Number.isSafeInteger(auth.generation) && auth.generation > 0)) &&
    (auth.mode === "writer" || auth.mode === "candidate" || auth.mode === "viewer" || auth.mode === "transferred") &&
    Array.isArray(auth.permissions) &&
    auth.permissions.length <= 16 &&
    auth.permissions.every(
      (permission) => typeof permission === "string" && /^[a-z]+:[a-z_]+$/.test(permission) && permission.length <= 64,
    ) &&
    (auth.mode === "writer" || auth.mode === "transferred" ? auth.generation !== null : auth.generation === null) &&
    typeof auth.matchId === "string" &&
    UUID_PATTERN.test(auth.matchId) &&
    (auth.leaseExpiresAt === null ||
      (typeof auth.leaseExpiresAt === "string" && expiresAtMs(auth.leaseExpiresAt) !== null)) &&
    (auth.mode === "writer" ? auth.leaseExpiresAt !== null : auth.leaseExpiresAt === null) &&
    expiry !== null &&
    expiry > now
  );
}

export class ScoringSessionSealer {
  readonly #key: Buffer;
  readonly #now: () => number;

  constructor(encodedKey: string, now: () => number = Date.now) {
    this.#key = decodeKey(encodedKey);
    this.#now = now;
  }

  seal(auth: ScoringServerAuth): string {
    if (!isValidAuth({ version: COOKIE_VERSION, ...auth }, this.#now())) throw new InvalidScoringSessionError();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(COOKIE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ version: COOKIE_VERSION, ...auth }), "utf8"),
      cipher.final(),
    ]);
    return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(value: string): ScoringServerAuth {
    try {
      const parts = value.split(".");
      if (parts.length !== 3) throw new InvalidScoringSessionError();
      const [encodedIv, encodedCiphertext, encodedTag] = parts;
      if (!encodedIv || !encodedCiphertext || !encodedTag) throw new InvalidScoringSessionError();
      const iv = Buffer.from(encodedIv, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext, "base64url");
      const tag = Buffer.from(encodedTag, "base64url");
      if (
        iv.length !== 12 ||
        tag.length !== 16 ||
        ciphertext.length === 0 ||
        iv.toString("base64url") !== encodedIv ||
        ciphertext.toString("base64url") !== encodedCiphertext ||
        tag.toString("base64url") !== encodedTag
      ) {
        throw new InvalidScoringSessionError();
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(COOKIE_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload: unknown = JSON.parse(plaintext);
      if (!isValidAuth(payload, this.#now())) throw new InvalidScoringSessionError();
      return {
        sessionId: payload.sessionId,
        sessionToken: payload.sessionToken,
        mode: payload.mode,
        permissions: payload.permissions,
        generation: payload.generation,
        matchId: payload.matchId,
        expiresAt: payload.expiresAt,
        leaseExpiresAt: payload.leaseExpiresAt,
      };
    } catch (error) {
      if (error instanceof InvalidScoringSessionError) throw error;
      throw new InvalidScoringSessionError();
    }
  }
}

export function scoringSessionCookie(value: string, expiresAt: string, now: number = Date.now()): string {
  const expiry = expiresAtMs(expiresAt);
  if (expiry === null || expiry <= now) throw new InvalidScoringSessionError();
  const maxAge = Math.max(1, Math.floor((expiry - now) / 1_000));
  return `${scoringSessionCookieName}=${value}; Path=/; Max-Age=${maxAge}; Expires=${new Date(expiry).toUTCString()}; Secure; HttpOnly; SameSite=Strict`;
}

export function expiredScoringSessionCookie(): string {
  return `${scoringSessionCookieName}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`;
}
