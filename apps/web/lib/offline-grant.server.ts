import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const COOKIE_VERSION = 1;
const COOKIE_AAD = Buffer.from("matchday-offline-grant-v1", "utf8");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export const offlineGrantCookieName = "__Secure-matchday-offline-grant";
export const offlineGrantCookiePath = "/api/scoring/offline";

export type OfflineGrantCredential = {
  authorizationId: string;
  resumeSecret: string;
  matchId: string;
  replayExpiresAt: string;
};

type SealedOfflineGrantCredential = OfflineGrantCredential & { version: number };

export class InvalidOfflineGrantError extends Error {
  constructor() {
    super("Offline scoring authority is unavailable.");
    this.name = "InvalidOfflineGrantError";
  }
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    throw new Error("SCORING_SESSION_SEAL_KEY must be the base64url encoding of exactly 32 random bytes.");
  }
  return key;
}

function timestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function validCredential(value: unknown, now: number): value is SealedOfflineGrantCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<SealedOfflineGrantCredential>;
  const expiry = typeof credential.replayExpiresAt === "string" ? timestamp(credential.replayExpiresAt) : null;
  return (
    credential.version === COOKIE_VERSION &&
    typeof credential.authorizationId === "string" &&
    UUID_PATTERN.test(credential.authorizationId) &&
    typeof credential.matchId === "string" &&
    UUID_PATTERN.test(credential.matchId) &&
    typeof credential.resumeSecret === "string" &&
    SECRET_PATTERN.test(credential.resumeSecret) &&
    expiry !== null &&
    expiry > now
  );
}

export class OfflineGrantSealer {
  readonly #key: Buffer;
  readonly #now: () => number;

  constructor(encodedKey: string, now: () => number = Date.now) {
    this.#key = decodeKey(encodedKey);
    this.#now = now;
  }

  seal(credential: OfflineGrantCredential): string {
    if (!validCredential({ version: COOKIE_VERSION, ...credential }, this.#now())) {
      throw new InvalidOfflineGrantError();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(COOKIE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ version: COOKIE_VERSION, ...credential }), "utf8"),
      cipher.final(),
    ]);
    return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(value: string): OfflineGrantCredential {
    try {
      const [encodedIv, encodedCiphertext, encodedTag, ...rest] = value.split(".");
      if (!encodedIv || !encodedCiphertext || !encodedTag || rest.length) throw new InvalidOfflineGrantError();
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
        throw new InvalidOfflineGrantError();
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(COOKIE_AAD);
      decipher.setAuthTag(tag);
      const payload: unknown = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
      );
      if (!validCredential(payload, this.#now())) throw new InvalidOfflineGrantError();
      return {
        authorizationId: payload.authorizationId,
        resumeSecret: payload.resumeSecret,
        matchId: payload.matchId,
        replayExpiresAt: payload.replayExpiresAt,
      };
    } catch (error) {
      if (error instanceof InvalidOfflineGrantError) throw error;
      throw new InvalidOfflineGrantError();
    }
  }
}

export function offlineGrantCookie(value: string, replayExpiresAt: string, now: number = Date.now()): string {
  const expiry = timestamp(replayExpiresAt);
  if (expiry === null || expiry <= now) throw new InvalidOfflineGrantError();
  const maxAge = Math.max(1, Math.floor((expiry - now) / 1_000));
  return `${offlineGrantCookieName}=${value}; Path=${offlineGrantCookiePath}; Max-Age=${maxAge}; Expires=${new Date(expiry).toUTCString()}; Secure; HttpOnly; SameSite=Strict`;
}

export function expiredOfflineGrantCookie(): string {
  return `${offlineGrantCookieName}=; Path=${offlineGrantCookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`;
}
