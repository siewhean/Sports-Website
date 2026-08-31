import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("public legal pages", () => {
  it("publishes substantive service terms from the shared legal catalogue", () => {
    const page = read("apps/web/app/terms/page.tsx");
    const catalogue = read("packages/ui/src/legal.ts");

    expect(page).toContain("legalMessages.terms.sections");
    for (const heading of [
      "Accounts and organiser responsibility",
      "Competition records and published information",
      "Billing and paid features",
      "Acceptable use",
      "Policy changes",
    ]) {
      expect(catalogue).toContain(heading);
    }
    expect(catalogue).not.toContain("Standard terms and conditions for Matchday organiser and scoring services apply");
  });

  it("publishes substantive privacy disclosures from the shared legal catalogue", () => {
    const page = read("apps/web/app/privacy/page.tsx");
    const catalogue = read("packages/ui/src/legal.ts");

    expect(page).toContain("legalMessages.privacy.sections");
    for (const heading of [
      "Information Matchday processes",
      "Public competition information",
      "Service providers and disclosures",
      "Retention and deletion",
      "Cookies and local storage",
      "Security and access",
    ]) {
      expect(catalogue).toContain(heading);
    }
    expect(catalogue).not.toMatch(/will be published before public launch/i);
  });
});
