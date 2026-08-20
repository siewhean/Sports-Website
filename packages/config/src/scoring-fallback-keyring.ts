import { z } from "zod";
import type { AppEnvironment } from "./index.js";

const keyVersionSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const keySchema = z
  .object({
    version: keyVersionSchema,
    secret: z.string().min(32).max(1_024),
  })
  .strict();
const keyringSchema = z
  .object({
    primary: keySchema,
    verificationOnly: z.array(keySchema).max(7).default([]),
  })
  .strict()
  .superRefine((keyring, context) => {
    const versions = [keyring.primary.version, ...keyring.verificationOnly.map((key) => key.version)];
    const material = [keyring.primary.secret, ...keyring.verificationOnly.map((key) => key.secret)];
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: "custom", message: "Fallback-code HMAC key versions must be unique" });
    }
    if (new Set(material).size !== material.length) {
      context.addIssue({ code: "custom", message: "Fallback-code HMAC key material must be unique" });
    }
  });

export type ScoringFallbackHmacKey = Readonly<{
  version: string;
  secret: string;
}>;

export type ScoringFallbackHmacKeyring = Readonly<{
  primary: ScoringFallbackHmacKey;
  verificationOnly: readonly ScoringFallbackHmacKey[];
}>;

/**
 * Loads the fallback-code verification keyring. Existing deployments may omit
 * the keyring and continue as a single `v1` primary; a rotation adds the old
 * primary to `verificationOnly` and installs the new primary atomically in the
 * deployment secret store.
 */
export function loadScoringFallbackHmacKeyring(
  legacyPrimarySecret: string,
  environment: AppEnvironment,
  source: NodeJS.ProcessEnv = process.env,
): ScoringFallbackHmacKeyring {
  const raw = source.SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING?.trim();
  if (!raw) {
    if (Buffer.byteLength(legacyPrimarySecret, "utf8") < 32) {
      throw new Error("Scoring fallback-code HMAC primary must contain at least 32 bytes");
    }
    return {
      primary: { version: "v1", secret: legacyPrimarySecret },
      verificationOnly: [],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING must be valid JSON");
  }
  const parsed = keyringSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      "SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING must contain one primary key and unique verification-only keys",
    );
  }
  if (environment !== "local" && environment !== "test" && parsed.data.primary.version === "v1") {
    // `v1` is valid during migration, but an explicitly configured deployed
    // keyring should not pretend a rotation occurred while retaining the
    // unversioned legacy primary name.
    if (parsed.data.verificationOnly.length > 0) {
      throw new Error("A deployed rotating fallback-code keyring must use a new primary version instead of v1");
    }
  }
  return parsed.data;
}
