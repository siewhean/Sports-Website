import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("public legal pages", () => {
  it("publishes substantive service terms", () => {
    const source = read("app/terms/page.tsx");
    for (const heading of [
      "Accounts and organiser responsibility",
      "Competition records and published information",
      "Billing and paid features",
      "Acceptable use",
      "Policy changes",
    ]) {
      expect(source).toContain(heading);
    }
    expect(source).not.toContain("Standard terms and conditions for Matchday organiser and scoring services apply");
  });

  it("publishes substantive privacy disclosures instead of a future-policy placeholder", () => {
    const source = read("app/privacy/page.tsx");
    for (const heading of [
      "Information Matchday processes",
      "Public competition information",
      "Service providers and disclosures",
      "Retention and deletion",
      "Cookies and local storage",
      "Security and access",
    ]) {
      expect(source).toContain(heading);
    }
    expect(source).not.toMatch(/will be published before public launch/i);
  });
});
