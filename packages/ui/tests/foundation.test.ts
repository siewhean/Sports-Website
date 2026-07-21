import { describe, expect, it } from "vitest";
import {
  CONSENT_STORAGE_KEY,
  createTranslator,
  createConsentPreferences,
  directionForLocale,
  formatCurrency,
  formatDateTime,
  formatNumber,
  interpolate,
  parseConsentPreferences,
  prototypeCatalogues,
  prototypeMessages,
  type PrototypeMessageId,
  pseudoLocalise,
  supportedLocales,
  translate,
} from "../src/index.js";

describe("consent contract", () => {
  it("keeps essential storage on and optional purposes off unless selected", () => {
    const preferences = createConsentPreferences(
      { analytics: true, marketing: false },
      new Date("2026-07-17T01:02:03.000Z"),
    );

    expect(CONSENT_STORAGE_KEY).toBe("matchday-consent-v1");
    expect(preferences).toEqual({
      version: 1,
      essential: true,
      analytics: true,
      marketing: false,
      decidedAt: "2026-07-17T01:02:03.000Z",
    });
    expect(parseConsentPreferences(JSON.stringify(preferences))).toEqual(preferences);
  });

  it("rejects stale, malformed or privilege-expanding stored values", () => {
    expect(parseConsentPreferences(null)).toBeNull();
    expect(parseConsentPreferences("not-json")).toBeNull();
    expect(
      parseConsentPreferences(
        JSON.stringify({
          version: 1,
          essential: false,
          analytics: true,
          marketing: true,
          decidedAt: "2026-07-17T01:02:03.000Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("locale-ready formatting", () => {
  it("formats competition values with an explicit locale and time zone", () => {
    expect(formatDateTime("2026-09-12T01:18:00.000Z", { hour: "2-digit", minute: "2-digit" })).toBe("09:18 am");
    expect(formatNumber(12_345)).toBe("12,345");
    expect(formatCurrency(49)).toBe("$49.00");
  });

  it("interpolates named message values without dropping unknown tokens", () => {
    expect(interpolate("Updated {time} · {missing}", { time: "09:18" })).toBe("Updated 09:18 · {missing}");
  });

  it("keeps date, number and Unicode formatting deterministic across locales and time zones", () => {
    const instant = "2026-09-12T01:18:00.000Z";
    expect(formatDateTime(instant, { hour: "2-digit", minute: "2-digit" }, "en-SG", "UTC")).toBe("01:18 am");
    expect(formatDateTime(instant, { hour: "2-digit", minute: "2-digit" }, "en-SG", "Asia/Singapore")).toBe("09:18 am");
    expect(formatNumber(12_345.6, "ar-EG")).toBe("١٢٬٣٤٥٫٦");
    expect(formatCurrency(49, "SGD", "zh-SG")).toContain("49.00");
  });
});

describe("typed prototype catalogue", () => {
  const assistedSetupId = "prototype.fe48ad8a445f" as const;
  const areaAvailabilityId = "prototype.ba8434f2ac3e" as const;
  const scoreAnnouncementId = "prototype.19261c6cd654" as const;

  it("has deterministic locale parity and rejects a missing key at runtime", () => {
    const expectedKeys = Object.keys(prototypeMessages).sort();
    expect(supportedLocales).toEqual(["en-SG", "en-XA", "ar"]);
    for (const locale of supportedLocales) {
      expect(Object.keys(prototypeCatalogues[locale]).sort()).toEqual(expectedKeys);
    }
    expect(() => translate("prototype.missing" as PrototypeMessageId)).toThrow(
      "Missing prototype message: prototype.missing",
    );
  });

  it("expands the pseudo locale while preserving and interpolating placeholders", () => {
    const english = translate(areaAvailabilityId, { number: 3 });
    const pseudo = createTranslator("en-XA")(areaAvailabilityId, { number: 3 });

    expect(pseudo).toContain("3");
    expect(pseudo).not.toContain("{number}");
    expect(pseudo.length).toBeGreaterThan(english.length * 1.25);
    expect(pseudoLocalise(prototypeMessages[assistedSetupId])).toMatch(/^\[!! .+ !!\]$/u);
  });

  it("preserves Unicode interpolation and exposes deterministic RTL direction", () => {
    const arabic = translate(scoreAnnouncementId, { team: "فريق 海星", status: "جاهز" }, "ar");

    expect(arabic).toContain("فريق 海星");
    expect(arabic).toContain("جاهز");
    expect(directionForLocale("ar")).toBe("rtl");
    expect(directionForLocale("en-SG")).toBe("ltr");
    expect(directionForLocale("en-XA")).toBe("ltr");
  });
});
