import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { legalMessages, legalPlaceholders, messages, retentionSchedule } from "@matchday/ui";
import { defaultRetentionPolicy } from "../../../../packages/config/src/retention";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const allPrivacyText = JSON.stringify(legalMessages.privacy) + JSON.stringify(retentionSchedule);

describe("public legal pages", () => {
  it("publishes substantive service terms from the shared legal catalogue", () => {
    const page = read("apps/web/app/terms/page.tsx");
    const catalogue = read("packages/ui/src/legal.ts");

    expect(page).toContain("legalMessages.terms.sections");
    for (const heading of [
      "Who provides Matchday",
      "Accounts and organiser responsibility",
      "Competition records and published information",
      "Billing and paid features",
      "Acceptable use",
      "Governing law and disputes",
      "Policy changes",
    ]) {
      expect(catalogue).toContain(heading);
    }
    expect(catalogue).not.toContain("Standard terms and conditions for Matchday organiser and scoring services apply");
  });

  it("states Singapore governing law and the legal entity placeholders in the terms", () => {
    const terms = JSON.stringify(legalMessages.terms);
    expect(terms).toContain("laws of Singapore");
    expect(terms).toContain(legalPlaceholders.organisationName);
    expect(terms).toContain(legalPlaceholders.registeredAddress);
    expect(terms).toContain(legalPlaceholders.governingLawCourts);
  });

  it("publishes substantive PDPA disclosures from the shared legal catalogue", () => {
    const page = read("apps/web/app/privacy/page.tsx");
    const catalogue = read("packages/ui/src/legal.ts");

    expect(page).toContain("legalMessages.privacy.sections");
    for (const heading of [
      "Who we are",
      "Data protection officer",
      "What we collect",
      "Why we use it",
      "What is public",
      "Who we share it with, and overseas transfers",
      "Your rights",
      "Cookies and local storage",
    ]) {
      expect(catalogue).toContain(heading);
    }
    for (const provider of [
      "Auth0",
      "Sentry",
      "Vercel",
      "Oracle Cloud Infrastructure in Singapore",
      "email provider",
    ]) {
      expect(allPrivacyText).toContain(provider);
    }
    for (const right of ["access", "correct", "delete", "withdraw consent"]) {
      expect(allPrivacyText).toContain(right);
    }
    expect(allPrivacyText).toContain(legalPlaceholders.dpoEmail);
    expect(catalogue).not.toMatch(/will be published before public launch/i);
  });

  it("keeps the published retention schedule in step with the purge defaults", () => {
    const periods = retentionSchedule.map((row) => row.period).join("\n");
    expect(periods).toContain(`${defaultRetentionPolicy.sessionDays} days`);
    expect(periods).toContain(`${defaultRetentionPolicy.scoringAttemptDays} days`);
    expect(periods).toContain(`${defaultRetentionPolicy.notificationDays} days`);
    expect(periods).toContain(`${defaultRetentionPolicy.billingReceiptDays} days`);
    expect(periods).toContain(`${defaultRetentionPolicy.providerEventDays} days`);
    expect(periods).toContain(`${defaultRetentionPolicy.anonymousCasualGameDays} days`);
  });

  it("highlights launch placeholders rather than hiding them", () => {
    const text = read("apps/web/components/foundation/LegalText.tsx");
    expect(text).toContain("data-legal-placeholder");
    expect(read("apps/web/app/privacy/page.tsx")).toContain("LegalText");
    expect(read("apps/web/app/terms/page.tsx")).toContain("LegalText");
  });

  it("requires the exact deletion phrase the API validates", () => {
    expect(messages.account.confirmationPhrase).toBe("DELETE MY ACCOUNT");
    expect(read("apps/api/src/account-data-rights-runtime.ts")).toContain(
      `accountDeletionConfirmationPhrase = "${messages.account.confirmationPhrase}"`,
    );
  });
});
