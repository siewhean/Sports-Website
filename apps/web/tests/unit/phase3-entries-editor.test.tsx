import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EntryEditorDivision } from "../../lib/phase3-entries";
import { phase3EntriesCopy } from "../../lib/phase3-entries";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { EntriesEditor } = await import("../../components/phase3/EntriesEditor");

const divisions: EntryEditorDivision[] = [
  {
    id: "division-1",
    name: "Open",
    entryLimit: 8,
    entries: [
      { id: "entry-1", name: "Team 1", seed: null, status: "active", entryType: "placeholder", revision: 1 },
      { id: "entry-2", name: "Harbour", seed: 1, status: "active", entryType: "team", revision: 3 },
      // Legacy read without entry_type/revision is treated as a named team.
      { id: "entry-3", name: "Marina", seed: 2, status: "confirmed" },
    ],
  },
];

function render(canEdit: boolean, input: EntryEditorDivision[] = divisions) {
  return renderToString(<EntriesEditor competitionId="competition-1" initialDivisions={input} canEdit={canEdit} />);
}

function entryItem(html: string, name: string): string {
  // Named entries render the name directly in <strong>; placeholders wrap it in a secondary-styled span.
  const start = html.indexOf(`>${name}<`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

function inputTags(html: string, name: string): string[] {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g")) ?? [];
}

function countOf(html: string, text: string): number {
  return html.split(text).length - 1;
}

describe("EntriesEditor planned teams", () => {
  it("renders the optional planned-teams input as a numeric text field", () => {
    const html = render(true);
    expect(html).toContain(phase3EntriesCopy.plannedTeams);
    const [planned] = inputTags(html, "planned-entry-count");
    expect(planned).toContain('inputMode="numeric"');
    expect(planned).toContain('pattern="[0-9]*"');
    expect(planned).not.toContain("required");
    expect(html).toContain(phase3EntriesCopy.plannedTeamsHint);
  });

  it("requires only the division name when creating a division", () => {
    const html = render(true);
    const start = html.indexOf('name="division-name"');
    const form = html.slice(html.lastIndexOf("<form", start), html.indexOf("</form>", start));
    const required = form.match(/<(input|select)[^>]*required[^>]*>/g) ?? [];
    expect(required).toHaveLength(1);
    expect(required[0]).toContain('name="division-name"');
  });

  it("marks placeholder entries as unnamed and offers a rename form", () => {
    const html = render(true);
    const placeholder = entryItem(html, "Team 1");
    expect(placeholder).toContain(phase3EntriesCopy.unnamedBadge);
    expect(html).toMatch(/<strong><span class="[^"]*">Team 1<\/span>/);
    expect(placeholder).toContain('name="placeholder-name"');
    expect(placeholder).toContain(phase3EntriesCopy.renameSave);
    expect(countOf(html, `>${phase3EntriesCopy.unnamedBadge}<`)).toBe(1);
    expect(countOf(html, 'name="placeholder-name"')).toBe(1);
  });

  it("does not mark named or legacy entries as unnamed", () => {
    const html = render(true);
    for (const name of ["Harbour", "Marina"]) {
      const item = entryItem(html, name);
      expect(item).not.toContain(phase3EntriesCopy.unnamedBadge);
      expect(item).not.toContain('name="placeholder-name"');
    }
  });

  it("offers a plan-more form and counts placeholders toward free-plan usage", () => {
    const html = render(true);
    expect(html).toContain(phase3EntriesCopy.planMore);
    expect(inputTags(html, "plan-entry-count")[0]).toContain('inputMode="numeric"');
    expect(html).toMatch(/<strong>3<!-- --> \/ <!-- -->16<\/strong>/);
  });

  it("disables plan-more when the division is full", () => {
    const full: EntryEditorDivision[] = [
      {
        id: "division-2",
        name: "Small",
        entryLimit: 8,
        entries: Array.from({ length: 8 }, (_, index) => ({
          id: `p-${index}`,
          name: `Small ${index + 1}`,
          seed: null,
          status: "active",
          entryType: "placeholder" as const,
          revision: 1,
        })),
      },
    ];
    const html = render(true, full);
    expect(inputTags(html, "plan-entry-count")[0]).toContain('disabled=""');
    expect(html).toMatch(new RegExp(`<button type="submit" disabled="">${phase3EntriesCopy.planMore}</button>`));
    // Placeholders can still be named when the division is full.
    const renames = inputTags(html, "placeholder-name");
    expect(renames).toHaveLength(8);
    expect(renames.every((tag) => !tag.includes("disabled"))).toBe(true);
  });

  it("disables every form in read-only mode", () => {
    const html = render(false);
    expect(html).toContain(phase3EntriesCopy.readOnly);
    for (const field of [
      "division-name",
      "planned-entry-count",
      "placeholder-name",
      "plan-entry-count",
      "entry-name",
    ]) {
      const tags = inputTags(html, field);
      expect(tags.length).toBeGreaterThan(0);
      expect(tags.every((tag) => tag.includes('disabled=""'))).toBe(true);
    }
    expect(html).not.toMatch(/<button type="submit">/);
  });
});
