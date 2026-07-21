export const CONSENT_STORAGE_KEY = "matchday-consent-v1";
export const CONSENT_VERSION = 1 as const;

export type ConsentPreferences = {
  version: typeof CONSENT_VERSION;
  essential: true;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string;
};

export const undecidedConsent = {
  version: CONSENT_VERSION,
  essential: true,
  analytics: false,
  marketing: false,
} as const;

export function createConsentPreferences(
  preferences: Pick<ConsentPreferences, "analytics" | "marketing">,
  now = new Date(),
): ConsentPreferences {
  return {
    ...undecidedConsent,
    ...preferences,
    decidedAt: now.toISOString(),
  };
}

export function parseConsentPreferences(value: string | null): ConsentPreferences | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;

    const candidate = parsed as Partial<ConsentPreferences>;
    if (
      candidate.version !== CONSENT_VERSION ||
      candidate.essential !== true ||
      typeof candidate.analytics !== "boolean" ||
      typeof candidate.marketing !== "boolean" ||
      typeof candidate.decidedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.decidedAt))
    ) {
      return null;
    }

    return candidate as ConsentPreferences;
  } catch {
    return null;
  }
}
