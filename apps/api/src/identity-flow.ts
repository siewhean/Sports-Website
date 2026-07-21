import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { IdentityError } from "@matchday/identity";

const FLOW_VERSION = 1;
const FLOW_AAD = Buffer.from("matchday-oidc-flow-v1", "utf8");
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const identityFlowTtlMs = 5 * 60 * 1_000;

export type IdentityFlow = {
  state: string;
  nonce: string;
  pkceVerifier: string;
  returnUri: string;
  issuedAt: number;
  expiresAt: number;
};

type SealedPayload = IdentityFlow & { version: number };

function authenticationFailed(): IdentityError {
  return new IdentityError("AUTHENTICATION_FAILED", "Authentication could not be completed.");
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    throw new Error("OIDC flow seal key must encode exactly 32 bytes.");
  }
  return key;
}

function validPayload(value: unknown): value is SealedPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SealedPayload>;
  return (
    payload.version === FLOW_VERSION &&
    typeof payload.state === "string" &&
    payload.state.length >= 32 &&
    payload.state.length <= 256 &&
    BASE64URL_PATTERN.test(payload.state) &&
    typeof payload.nonce === "string" &&
    payload.nonce.length >= 32 &&
    payload.nonce.length <= 256 &&
    BASE64URL_PATTERN.test(payload.nonce) &&
    typeof payload.pkceVerifier === "string" &&
    payload.pkceVerifier.length >= 43 &&
    payload.pkceVerifier.length <= 128 &&
    BASE64URL_PATTERN.test(payload.pkceVerifier) &&
    typeof payload.returnUri === "string" &&
    payload.returnUri.length <= 2_048 &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    (payload.expiresAt as number) > (payload.issuedAt as number)
  );
}

export class IdentityFlowSealer {
  readonly #key: Buffer;
  readonly #now: () => number;

  constructor(encodedKey: string, now: () => number = Date.now) {
    this.#key = decodeKey(encodedKey);
    this.#now = now;
  }

  seal(input: Omit<IdentityFlow, "issuedAt" | "expiresAt">): string {
    const issuedAt = this.#now();
    const payload: SealedPayload = {
      version: FLOW_VERSION,
      ...input,
      issuedAt,
      expiresAt: issuedAt + identityFlowTtlMs,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(FLOW_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(value: string): IdentityFlow {
    try {
      const parts = value.split(".");
      if (parts.length !== 3) throw authenticationFailed();
      const [encodedIv, encodedCiphertext, encodedTag] = parts;
      if (!encodedIv || !encodedCiphertext || !encodedTag) throw authenticationFailed();
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
        throw authenticationFailed();
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(FLOW_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload: unknown = JSON.parse(plaintext);
      if (!validPayload(payload) || this.#now() < payload.issuedAt - 60_000 || this.#now() >= payload.expiresAt) {
        throw authenticationFailed();
      }
      return {
        state: payload.state,
        nonce: payload.nonce,
        pkceVerifier: payload.pkceVerifier,
        returnUri: payload.returnUri,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
      };
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw authenticationFailed();
    }
  }

  stateMatches(expected: string, actual: string): boolean {
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(actual, "utf8");
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }
}
